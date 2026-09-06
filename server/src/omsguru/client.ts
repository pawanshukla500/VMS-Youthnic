// Server-side OMSGuru API client. Credentials MUST stay here — never ship
// the token to browsers (invoice payloads contain buyer PII and the token
// would let anyone burn the 60req/5min rate budget).
// Verified live against the account: Bearer token + Oms-Cid headers,
// form-encoded POST bodies, cursor pagination via last_id.

const BASE_URL = (process.env.OMSGURU_BASE_URL || 'https://client.omsguru.com').replace(/\/+$/, '');

export function omsguruCredentials(): { token: string; cid: string } {
  const token = (process.env.OMSGURU_TOKEN || '').trim();
  const cid = (process.env.OMSGURU_CID || '').trim();
  if (!token || !cid) {
    throw new Error('OMSGuru is not configured (OMSGuru_TOKEN / OMSGuru_CID)');
  }
  return { token, cid };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path: string, params: Record<string, string>, attempts = 4): Promise<any> {
  const { token, cid } = omsguruCredentials();
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Oms-Cid': cid,
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

    const data: any = await res.json();
    return Array.isArray(data) ? data : data?.data || [];
  }

  throw lastError instanceof Error ? lastError : new Error('OMSGuru request failed');
}

async function get(path: string, params: Record<string, string>): Promise<any> {
  const { token, cid } = omsguruCredentials();
  const query = new URLSearchParams(params);
  const res = await fetch(`${BASE_URL}${path}?${query}`, {
    headers: { Authorization: `Bearer ${token}`, 'Oms-Cid': cid },
  });
  if (!res.ok) {
    throw new Error(`OMSGuru ${path} failed: HTTP ${res.status}`);
  }
  const data: any = await res.json();
  return Array.isArray(data) ? data : data?.data || [];
}

export async function listActiveChannels(): Promise<Array<{ id: number; name: string; channel: string }>> {
  const channels = await get('/order_api/list_channels', { status: 'active' });
  return channels.map((c: any) => ({
    id: Number(c.id),
    name: String(c.name || ''),
    channel: String(c.channel_name || c.name || ''),
  }));
}

export async function listListingsPage(channelCompanyId: number, lastId: number): Promise<any[]> {
  return request('/order_api/list_channel_listings', {
    channel_company_id: String(channelCompanyId),
    last_id: String(lastId),
  });
}

export async function listInvoicesPage(options: {
  start: number;
  end: number;
  warehouseId: string;
  lastId: number;
  limit?: number;
}): Promise<any[]> {
  return request('/order_api/invoices', {
    start_invoice_date: String(options.start),
    end_invoice_date: String(options.end),
    warehouse_id: options.warehouseId,
    last_id: String(options.lastId),
    limit: String(options.limit || 100),
  });
}

export const omsguruGentleDelay = () => sleep(300);
