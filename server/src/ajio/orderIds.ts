// Ajio order identity for video renames (unit-tested).
//
// Ajio recordings are renamed ONLY by the Order Imports file upload, and only
// to Ajio's customer order numbers — letters followed by digits, e.g.
// FN6042808575 or EX... (the ExtraInfo column). Plain channel order ids
// ("1248722659") and sub-order ids ("1248722659.9") never rename a video;
// such rows are still acknowledged and file the video under Ajio.
const AJIO_RENAME_ORDER_ID = /^[A-Z]{2,4}\d{6,}$/i;

export function isAjioRenameOrderId(value: unknown): boolean {
  return typeof value === 'string' && AJIO_RENAME_ORDER_ID.test(value.trim());
}
