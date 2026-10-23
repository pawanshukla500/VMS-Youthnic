import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_AJIO_ALERT_EMAIL,
  wfrAlertRecipients,
  wfrAlertsConfigured,
  getWfrHealth,
} from '../ajio/watchdog';
import { isAjioRenameOrderId } from '../ajio/orderIds';
import { buildReplyAllRecipients, AJIO_WFR_TRACKING_EMAIL } from '../ajio/mailbox';
import { buildReplyBody, buildReplyHtmlBody, AJIO_WFR_TRACKING_EMAIL as TEMPLATE_TRACKING_EMAIL } from '../ajio/template';
import { relinkMissingAjioWfrRequests } from '../ajio/processor';

describe('Ajio WFR & Alert settings', () => {
  it('defaults alert recipients to returnorders@vbexports.co.in when unset', () => {
    expect(DEFAULT_AJIO_ALERT_EMAIL).toBe('returnorders@vbexports.co.in');
    expect(wfrAlertRecipients({} as any)).toEqual(['returnorders@vbexports.co.in']);
  });

  it('allows custom emails to override env and default', () => {
    const custom = 'ops@vbexports.co.in, alerts@youthnic.shop';
    expect(wfrAlertRecipients({ AJIO_ALERT_EMAILS: 'other@test.com' } as any, custom)).toEqual([
      'ops@vbexports.co.in',
      'alerts@youthnic.shop',
    ]);
  });

  it('determines alertsConfigured using custom key and custom emails', () => {
    expect(wfrAlertsConfigured({} as any, 'ops@vbexports.co.in', 're_testkey123')).toBe(true);
    expect(wfrAlertsConfigured({} as any, 'ops@vbexports.co.in', '   ')).toBe(false);
  });

  it('getWfrHealth reads custom settings from ajio_settings table if available', async () => {
    const mockPool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM ajio_settings')) {
          return { rows: [{ alert_emails: 'custom@vbexports.co.in', resend_api_key: 're_123' }] };
        }
        if (sql.includes('FROM ajio_wfr_runs')) {
          return { rows: [] };
        }
        if (sql.includes('FROM ajio_wfr_requests')) {
          return { rows: [{ count: 0, oldest: null }] };
        }
        return { rows: [] };
      }),
    } as any;

    const health = await getWfrHealth(mockPool, '00000000-0000-0000-0000-000000000001', {} as any);
    expect(health.alertsConfigured).toBe(true);
  });
});

describe('Ajio B2C customer order IDs (FN/EX)', () => {
  it('identifies customer order numbers starting with FN and EX', () => {
    expect(isAjioRenameOrderId('FN6042808575')).toBe(true);
    expect(isAjioRenameOrderId('EX1234567890')).toBe(true);
    expect(isAjioRenameOrderId('fn2457603351')).toBe(true);
    expect(isAjioRenameOrderId('ex999888777')).toBe(true);
  });

  it('rejects numeric shipment ids and non-order strings', () => {
    expect(isAjioRenameOrderId('1262142448')).toBe(false);
    expect(isAjioRenameOrderId('1248722659.9')).toBe(false);
    expect(isAjioRenameOrderId('SHORT')).toBe(false);
    expect(isAjioRenameOrderId('')).toBe(false);
    expect(isAjioRenameOrderId(null)).toBe(false);
  });
});

describe('Ajio WFR reply tracking and copy mention', () => {
  it('adds ajio-wfr@youthnic.shop to CC in reply-all recipients', () => {
    expect(AJIO_WFR_TRACKING_EMAIL).toBe('ajio-wfr@youthnic.shop');
    expect(TEMPLATE_TRACKING_EMAIL).toBe('ajio-wfr@youthnic.shop');

    const recipients = buildReplyAllRecipients(
      {
        from: 'seller.communication@ajio.com',
        toAddrs: ['seller.communication@ajio.com'],
        ccAddrs: ['boss@shop.com'],
      },
      'nidhi@shop.com'
    );

    expect(recipients.to).toContain('seller.communication@ajio.com');
    expect(recipients.cc).toContain('boss@shop.com');
    expect(recipients.cc).toContain('ajio-wfr@youthnic.shop');
  });

  it('includes tracking email mention in reply body and html', () => {
    const ctx = {
      incidentId: 'INC12345',
      orderId: 'FN6042808575',
      shipmentId: '1262142448',
      referenceValue: 'AWB999',
      packingTimeText: '23-10-2026 12:30 IST',
      driveLink: 'https://drive.google.com/file/d/test/view',
      fileName: 'FN6042808575.mp4',
      senderName: 'Youthnic Packing (VMS)',
    };

    const text = buildReplyBody(ctx);
    const html = buildReplyHtmlBody(ctx);

    expect(text).toContain('Tracking Copy: ajio-wfr@youthnic.shop');
    expect(html).toContain('ajio-wfr@youthnic.shop');
  });
});

describe('relinkMissingAjioWfrRequests', () => {
  it('queries open/missing requests and links found video candidates', async () => {
    const mockPool = {
      query: vi.fn(async (sql: string, params: any[]) => {
        if (sql.includes('SELECT id, incident_id, order_id, shipment_id')) {
          return {
            rows: [
              {
                id: 'req-1',
                incident_id: 'INC001',
                order_id: 'FN6042808575',
                shipment_id: '1262142448',
                reference_value: 'AWB123',
                packing_time: new Date().toISOString(),
              },
            ],
          };
        }
        if (sql.includes('FROM marketplace_order_mappings')) {
          return { rows: [{ tracking_id: 'AWB123', order_id: 'FN6042808575' }] };
        }
        if (sql.includes('FROM marketplace_orders')) {
          return { rows: [{ tracking_id: 'AWB123', order_id: 'FN6042808575', channel_order_id: '1262142448' }] };
        }
        if (sql.includes('FROM recording_sessions rs')) {
          return {
            rows: [
              {
                id: 'rec-1',
                tracking_id: 'AWB123',
                order_id: 'FN6042808575',
                has_video: true,
                storage_path: 'packing-videos/rec-1.mp4',
                created_at: new Date().toISOString(),
              },
            ],
          };
        }
        if (sql.includes('UPDATE ajio_wfr_requests')) {
          return { rowCount: 1 };
        }
        return { rows: [] };
      }),
    } as any;

    const result = await relinkMissingAjioWfrRequests(mockPool, '00000000-0000-0000-0000-000000000001');
    expect(result.checked).toBe(1);
    expect(result.linked).toBe(1);
  });
});
