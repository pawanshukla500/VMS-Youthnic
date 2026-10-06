// Server-side OMSGuru API client. Credentials MUST stay here — never ship
// the token to browsers (invoice payloads contain buyer PII and the token
// would let anyone burn the 60req/5min rate budget).
// Verified live against the account: Bearer token + Oms-Cid headers,
// form-encoded POST bodies, cursor pagination via last_id. The API answers
// either bare arrays or {error, message, data} envelopes.

export interface OMSGuruCreds {
  token: string;
  cid: string;
}

export function omsguruCredentials(override?: Partial<OMSGuruCreds>): OMSGuruCreds {
  const token = (override?.token ?? process.env.OMSGURU_TOKEN ?? '').trim();
  const cid = (override?.cid ?? process.env.OMSGURU_CID ?? '').trim();
  if (!token || !cid) {
    throw new Error('OMSGuru is not configured (token / client ID)');
  }
  return { token, cid };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RATE_CAPACITY = 60;
const RATE_REFILL_MS = 5_000;
const rateBuckets = new Map<string, { tokens: number; updatedAt: number }>();

// Last X-OMS-* headers seen per account. The budget (60 calls / 5 min) is
// shared with Forward Scan, so background jobs read this to step aside
// before the window runs dry instead of finding out via throttling.
export interface OMSGuruRateSnapshot {
  limit: number | null;
  remaining: number;
  resetAtMs: number | null;
  seenAtMs: number;
}
const rateSnapshots = new Map<string, OMSGuruRateSnapshot>();

export function omsguruRateSnapshot(creds: OMSGuruCreds): OMSGuruRateSnapshot | null {
  return rateSnapshots.get(`${creds.cid}:${creds.token}`) || null;
}

function headerNumber(res: Response, name: string): number {
  const value = res.headers?.get?.(name);
  return value ? Number(value) : NaN;
}

async function acquireRateToken(creds: OMSGuruCreds): Promise<void> {
  const key = `${creds.cid}:${creds.token}`;
  let bucket = rateBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: RATE_CAPACITY, updatedAt: Date.now() };
    rateBuckets.set(key, bucket);
  }

  while (true) {
    const now = Date.now();
    bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + (now - bucket.updatedAt) / RATE_REFILL_MS);
    bucket.updatedAt = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    await sleep(Math.max(100, Math.ceil((1 - bucket.tokens) * RATE_REFILL_MS)));
  }
}

function normalizeList(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

// Throttling arrives two ways (both documented): HTTP 429, or HTTP 200 with
// an `{error: -4, message: "API Throttled"}` envelope (sometimes as plain
// text, which is why the GAS inventory script string-matches the body).
export class OMSGuruThrottledError extends Error {
  retryAfterSec: number;
  constructor(message: string, retryAfterSec: number) {
    super(message);
    this.name = 'OMSGuruThrottledError';
    this.retryAfterSec = retryAfterSec;
  }
}

function parseListPayload(text: string, path: string): any[] {
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const message = String(payload.message || '');
    if (payload.error === -4 || /api\s*throttled/i.test(message)) {
      throw new OMSGuruThrottledError(`OMSGuru ${path} throttled: ${message || 'API Throttled'}`, 0);
    }
    if (payload.error !== undefined && payload.error !== 0) {
      throw new Error(`OMSGuru ${path} failed: ${message || `API error ${payload.error}`}`);
    }
  }
  if (payload === null) {
    // Non-JSON bodies only happen on throttling pages — back off instead of
    // caching the error as "not found".
    if (/api\s*throttled/i.test(text || '')) {
      throw new OMSGuruThrottledError(`OMSGuru ${path} throttled`, 0);
    }
    throw new Error(`OMSGuru ${path} failed: unreadable response`);
  }
  return normalizeList(payload);
}

async function fetchList(
  creds: OMSGuruCreds,
  path: string,
  url: string,
  init: RequestInit,
  attempts = 4
): Promise<any[]> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    await acquireRateToken(creds);
    const res = await fetch(url, init);

    const remaining = headerNumber(res, 'X-OMS-Remaining');
    const bucket = rateBuckets.get(`${creds.cid}:${creds.token}`);
    if (bucket && Number.isFinite(remaining)) bucket.tokens = Math.min(bucket.tokens, Math.max(0, remaining));
    if (Number.isFinite(remaining)) {
      const limit = headerNumber(res, 'X-OMS-Limit');
      const reset = headerNumber(res, 'X-OMS-Reset');
      rateSnapshots.set(`${creds.cid}:${creds.token}`, {
        limit: Number.isFinite(limit) ? limit : null,
        remaining,
        // Epoch seconds (seen live, e.g. 1791303203).
        resetAtMs: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
        seenAtMs: Date.now(),
      });
    }

    const readText = async (): Promise<string> =>
      typeof (res as any).text === 'function' ? (await (res as any).text()) ?? '' : '';

    // Throttling arrives as HTTP 429 OR as a throttled envelope/body on any
    // other status — both back off the same way.
    if (res.status === 429) {
      const retryAfter = Number(res.headers?.get?.('Retry-After') || '10');
      lastError = new OMSGuruThrottledError('OMSGuru throttled (429)', Number.isFinite(retryAfter) ? retryAfter : 10);
    } else {
      try {
        const text = await readText();
        if (!res.ok) {
          // Non-OK bodies are hard failures (auth, params) unless the body
          // itself says throttled — then parseListPayload throws the
          // throttled error and we back off below.
          parseListPayload(text, path);
          throw new Error(`OMSGuru ${path} failed: HTTP ${res.status}`);
        }
        return parseListPayload(text, path);
      } catch (err) {
        if (err instanceof OMSGuruThrottledError) {
          lastError = err;
        } else {
          throw err;
        }
      }
    }

    if (bucket) {
      bucket.tokens = 0;
      bucket.updatedAt = Date.now();
    }
    const retryAfter = lastError instanceof OMSGuruThrottledError ? lastError.retryAfterSec : 0;
    const exponential = Math.min(30, 2 ** attempt);
    await sleep(Math.max(retryAfter > 0 ? retryAfter : 10, exponential) * 1000);
  }

  throw lastError instanceof Error ? lastError : new Error('OMSGuru request failed');
}

async function request(creds: OMSGuruCreds, path: string, params: Record<string, string>, attempts?: number): Promise<any[]> {
  return fetchList(creds, path, `${OMSGURU_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Oms-Cid': creds.cid,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  }, attempts);
}

async function get(creds: OMSGuruCreds, path: string, params: Record<string, string>, attempts?: number): Promise<any[]> {
  const query = new URLSearchParams(params);
  return fetchList(creds, path, `${OMSGURU_BASE}${path}?${query}`, {
    headers: { Authorization: `Bearer ${creds.token}`, 'Oms-Cid': creds.cid },
  }, attempts);
}

const OMSGURU_BASE = (process.env.OMSGURU_BASE_URL || 'https://client.omsguru.com').replace(/\/+$/, '');

function safePageLimit(value: number | undefined): string {
  const limit = Number.isFinite(value) ? Number(value) : 50;
  return String(Math.min(50, Math.max(1, limit)));
}

// options.attempts: background jobs pass 1 — they pause on their own, so
// in-client retries would only keep hitting an exhausted shared budget.
export function createOMSGuruClient(creds: OMSGuruCreds, options: { attempts?: number } = {}) {
  const attempts = options.attempts && options.attempts > 0 ? Math.floor(options.attempts) : undefined;
  return {
    listActiveChannels: async (): Promise<Array<{ id: number; name: string; channel: string }>> => {
      const channels = await get(creds, '/order_api/list_channels', { status: 'active' }, attempts);
      return channels.map((c: any) => ({
        id: Number(c.id),
        name: String(c.name || ''),
        channel: String(c.channel_name || c.name || ''),
      }));
    },
    listListingsPage: (channelCompanyId: number, lastId: number): Promise<any[]> =>
      request(creds, '/order_api/list_channel_listings', {
        channel_company_id: String(channelCompanyId),
        last_id: String(lastId),
      }, attempts),
    listInvoicesPage: (options: { start: number; end: number; warehouseId?: string; lastId: number; limit?: number }): Promise<any[]> => {
      // warehouse_id omitted = all warehouses in one stream (Swagger:
      // "if you do not pass the value, then it will return orders from all
      // warehouse"). Proven live.
      const params: Record<string, string> = {
        start_invoice_date: String(options.start),
        end_invoice_date: String(options.end),
        last_id: String(options.lastId),
        limit: safePageLimit(options.limit),
      };
      if (options.warehouseId) params.warehouse_id = options.warehouseId;
      return request(creds, '/order_api/invoices', params);
    },
    listOrdersPage: (options: { start: number; end: number; warehouseId: string; statusId?: string; lastId: number; limit?: number }): Promise<any[]> => {
      // status_id omitted = all statuses in one stream (proven live despite
      // the contract marking it required). warehouse_id is still required.
      const params: Record<string, string> = {
        start_order_date: String(options.start),
        end_order_date: String(options.end),
        warehouse_id: options.warehouseId,
        last_id: String(options.lastId),
        limit: safePageLimit(options.limit),
      };
      if (options.statusId) params.status_id = options.statusId;
      return request(creds, '/order_api/orders', params);
    },
    // Warehouse directory for diagnostics/config (1 call, on demand only).
    listWarehouses: async (): Promise<Array<{ id: string; name: string }>> => {
      const rows = await get(creds, '/order_api/warehouses', {});
      return rows
        .map((w: any) => ({
          id: String(w?.id ?? w?.warehouse_id ?? ''),
          name: String(w?.name ?? w?.warehouse_name ?? w?.title ?? ''),
        }))
        .filter((w) => w.id);
    },
  };
}

export type OMSGuruClient = ReturnType<typeof createOMSGuruClient>;

export const omsguruGentleDelay = () => sleep(300);
