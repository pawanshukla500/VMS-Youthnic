// Ajio WFR reply template (pure, unit-tested).
//
// Ajio's rules, from the mail itself: reply to the original thread
// ("Reply all"), keep the subject line UNCHANGED, and name the shared file
// by ORDER ID only (no special characters or spaces).
export interface AjioReplyContext {
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
    '',
    'The subject line has been kept unchanged for your reference.',
    '',
    'Regards,',
    ctx.senderName,
  ];
  return lines.join('\n');
}
