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

function normalizeList(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

async function request(creds: OMSGuruCreds, path: string, params: Record<string, string>, attempts = 4): Promise<any[]> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await fetch(`${OMSGURU_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'Oms-Cid': creds.cid,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') || '10');
      lastError = new Error('OMSGuru throttled (429)');
      await sleep((Number.isFinite(retryAfter) ? retryAfter : 10) * 1000);
      continue;
    }

    if (!res.ok) {
      throw new Error(`OMSGuru ${path} failed: HTTP ${res.status}`);
    }

    return normalizeList(await res.json());
  }

  throw lastError instanceof Error ? lastError : new Error('OMSGuru request failed');
}

async function get(creds: OMSGuruCreds, path: string, params: Record<string, string>): Promise<any[]> {
  const query = new URLSearchParams(params);
  const res = await fetch(`${OMSGURU_BASE}${path}?${query}`, {
    headers: { Authorization: `Bearer ${creds.token}`, 'Oms-Cid': creds.cid },
  });
  if (!res.ok) {
    throw new Error(`OMSGuru ${path} failed: HTTP ${res.status}`);
  }
  return normalizeList(await res.json());
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
