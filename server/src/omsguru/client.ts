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

async function responseList(res: Response, path: string): Promise<any[]> {
  const payload: any = await res.json();
  if (payload && payload.error !== undefined && payload.error !== 0) {
    throw new Error(`OMSGuru ${path} failed: ${payload.message || `API error ${payload.error}`}`);
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

    const remaining = Number(res.headers?.get?.('X-OMS-Remaining') || '');
    const bucket = rateBuckets.get(`${creds.cid}:${creds.token}`);
    if (bucket && Number.isFinite(remaining)) bucket.tokens = Math.min(bucket.tokens, Math.max(0, remaining));

    if (res.status === 429) {
      const retryAfter = Number(res.headers?.get?.('Retry-After') || '10');
      lastError = new Error('OMSGuru throttled (429)');
      if (bucket) {
        bucket.tokens = 0;
        bucket.updatedAt = Date.now();
      }
      const exponential = Math.min(30, 2 ** attempt);
      await sleep(Math.max(Number.isFinite(retryAfter) ? retryAfter : 10, exponential) * 1000);
      continue;
    }

    if (!res.ok) {
      throw new Error(`OMSGuru ${path} failed: HTTP ${res.status}`);
    }

    return responseList(res, path);
  }

  throw lastError instanceof Error ? lastError : new Error('OMSGuru request failed');
}

async function request(creds: OMSGuruCreds, path: string, params: Record<string, string>): Promise<any[]> {
  return fetchList(creds, path, `${OMSGURU_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Oms-Cid': creds.cid,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
}

async function get(creds: OMSGuruCreds, path: string, params: Record<string, string>): Promise<any[]> {
  const query = new URLSearchParams(params);
  return fetchList(creds, path, `${OMSGURU_BASE}${path}?${query}`, {
    headers: { Authorization: `Bearer ${creds.token}`, 'Oms-Cid': creds.cid },
  });
}

const OMSGURU_BASE = (process.env.OMSGURU_BASE_URL || 'https://client.omsguru.com').replace(/\/+$/, '');

export function createOMSGuruClient(creds: OMSGuruCreds) {
  return {
    listActiveChannels: async (): Promise<Array<{ id: number; name: string; channel: string }>> => {
      const channels = await get(creds, '/order_api/list_channels', { status: 'active' });
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
      }),
    listInvoicesPage: (options: { start: number; end: number; warehouseId: string; lastId: number; limit?: number }): Promise<any[]> =>
      request(creds, '/order_api/invoices', {
        start_invoice_date: String(options.start),
        end_invoice_date: String(options.end),
        warehouse_id: options.warehouseId,
        last_id: String(options.lastId),
        limit: String(options.limit || 100),
      }),
    listOrdersPage: (options: { start: number; end: number; warehouseId: string; statusId: string; lastId: number; limit?: number }): Promise<any[]> =>
      request(creds, '/order_api/orders', {
        start_order_date: String(options.start),
        end_order_date: String(options.end),
        warehouse_id: options.warehouseId,
        status_id: options.statusId,
        last_id: String(options.lastId),
        limit: String(options.limit || 100),
      }),
  };
}

export type OMSGuruClient = ReturnType<typeof createOMSGuruClient>;

export const omsguruGentleDelay = () => sleep(300);
