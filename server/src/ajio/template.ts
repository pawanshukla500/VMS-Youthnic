// Ajio WFR reply template (pure, unit-tested).
//
// Ajio's rules, from the mail itself: reply to the original thread
// ("Reply all"), keep the subject line UNCHANGED, and name the shared file
// by ORDER ID only (no special characters or spaces).
export const AJIO_WFR_TRACKING_EMAIL = 'ajio-wfr@youthnic.shop';

export interface AjioReplyContext {
  trackingEmail?: string;
  incidentId: string;
  orderId: string;
  shipmentId: string | null;
  referenceValue: string | null;
  packingTimeText: string | null;
  driveLink: string;
  fileName: string;
  senderName: string;
}

export function sanitizeDriveFilename(orderId: string): string {
  const base = (orderId || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${base || 'packing-video'}.mp4`;
}

export function buildReplySubject(originalSubject: string): string {
  return originalSubject;
}

function escapeHtml(value: string | null): string {
  return (value || '-')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildReplyBody(ctx: AjioReplyContext): string {
  const lines = [
    'Hi Team,',
    '',
    `As requested against Ticket ${ctx.incidentId} (Order ${ctx.orderId}), please find the packing footage for the reported order below. The file is named by ORDER ID as instructed.`,
    '',
    `Order ID: ${ctx.orderId}`,
    `Shipment ID: ${ctx.shipmentId || '-'}`,
    `Reference Value: ${ctx.referenceValue || '-'}`,
    `Packing Time: ${ctx.packingTimeText || '-'}`,
    `Video (Google Drive): ${ctx.driveLink}`,
    `File name: ${ctx.fileName}`,
    `Tracking Copy: ${ctx.trackingEmail || AJIO_WFR_TRACKING_EMAIL}`,
    '',
    'The subject line has been kept unchanged for your reference.',
    '',
    'Regards,',
    ctx.senderName,
  ];
  return lines.join('\n');
}

// HTML twin of the plain body: same facts, table layout, Drive button.
// Email-safe (tables + inline styles, no external assets). The plain body
// always ships alongside as multipart/alternative for strict readers.
export function buildReplyHtmlBody(ctx: AjioReplyContext): string {
  const row = (label: string, value: string | null, bold = false) => `
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;color:#64748b;font-size:13px;width:160px;">${label}</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;color:#0f172a;font-size:13px;${bold ? 'font-weight:700;' : ''}">${escapeHtml(value)}</td>
      </tr>`;
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
    <div style="background-color:#0f172a;border-radius:8px 8px 0 0;padding:16px 24px;">
      <div style="color:#ffffff;font-size:16px;font-weight:700;">Youthnic Packing (VMS)</div>
      <div style="color:#94a3b8;font-size:13px;">Packing footage &mdash; Ticket ${escapeHtml(ctx.incidentId)}</div>
    </div>
    <div style="background-color:#ffffff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:24px;">
      <p style="color:#0f172a;font-size:14px;margin:0 0 8px;">Hi Team,</p>
      <p style="color:#334155;font-size:14px;line-height:1.6;margin:0 0 16px;">As requested against Ticket ${escapeHtml(ctx.incidentId)} (Order ${escapeHtml(ctx.orderId)}), please find the packing footage for the reported order below. The file is named by ORDER ID as instructed.</p>
      <table style="border-collapse:collapse;width:100%;margin:0 0 16px;">
        <tbody>${row('Ticket', ctx.incidentId)}${row('Order ID', ctx.orderId, true)}${row('Shipment ID', ctx.shipmentId)}${row('Reference Value', ctx.referenceValue)}${row('Packing Time', ctx.packingTimeText)}${row('File name', ctx.fileName)}${row('Tracking Copy', ctx.trackingEmail || AJIO_WFR_TRACKING_EMAIL)}
        </tbody>
      </table>
      <div style="margin:0 0 16px;">
        <a href="${escapeHtml(ctx.driveLink)}" style="display:inline-block;background-color:#16a34a;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;padding:12px 24px;border-radius:6px;">Open packing video (Google Drive)</a>
      </div>
      <p style="color:#64748b;font-size:12px;line-height:1.6;margin:0 0 16px;">Video link: <a href="${escapeHtml(ctx.driveLink)}" style="color:#16a34a;">${escapeHtml(ctx.driveLink)}</a><br>The subject line has been kept unchanged for your reference.</p>
      <p style="color:#0f172a;font-size:14px;margin:0;">Regards,<br>${escapeHtml(ctx.senderName)}</p>
    </div>
  </div>
</body></html>`;
}
