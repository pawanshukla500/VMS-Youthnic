// Pure helpers for the packing-station scan flow (unit-tested).

// Barcode scanners act as keyboards: strip surrounding whitespace/newlines
// the scanner or operator may add. Returns '' when nothing scannable remains.
// Every scanned id is stored in CAPITALS whatever the scanner's caps-lock
// state (sf4158705460fpl -> SF4158705460FPL), so lookups, renames and
// reports never split one parcel into two spellings.
export function normalizeScannedId(raw: string): string {
  return (raw || '').trim().toUpperCase();
}

// A second scan of the parcel already being recorded (scanner double-read)
// must not split the session: stop + restart would cut one parcel's video
// in two. Comparison is exact after normalization; different IDs always
// start a new session.
export function isDuplicateScan(currentTrackingId: string | null | undefined, nextTrackingId: string): boolean {
  if (!currentTrackingId || !nextTrackingId) return false;
  return currentTrackingId === nextTrackingId;
}

// Meesho detection (order identity, Synced Orders). Mirrors the server's
// sub-order identity rule: any marketplace name containing "meesho"
// (case-insensitive). Null-safe by design.
export function isMeeshoMarketplace(marketplace: string | null | undefined): boolean {
  return typeof marketplace === 'string' && marketplace.toLowerCase().includes('meesho');
}

// Courier AWBs that never belong to Meesho: Flipkart E-Kart (FMP...) and
// Myntra (MYS.../MYE...). VMS does not copy those marketplaces' orders, so
// the prefix is what marks them known non-Meesho.
export function isKnownNonMeeshoTracking(trackingId: string | null | undefined): boolean {
  if (!trackingId) return false;
  return /^(FMP|MYS|MYE)[A-Z0-9]{6,}/.test(trackingId.trim().toUpperCase());
}

// Meesho flyer bag barcodes start with 'TP' (e.g. TP4OOEU08339990), or a
// common bag prefix. Flyer scan was removed (Oct 2026): such a scan is a
// wrong scan, so a habit scan of the bag never cuts the parcel's video.
export function isFlyerBarcode(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const val = raw.trim().toUpperCase();
  if (val.length < 6) return false;
  // Meesho transparent packaging packets start with 'TP'
  if (/^TP[A-Z0-9]{4,}/.test(val)) return true;
  if (/^(PKT|FLY|BAG)[A-Z0-9]{4,}/.test(val)) return true;
  return false;
}

// Wrong-scan guard. Shipping labels carry plain letters and digits; codes
// like "STGNrPmlYc_001_v" (garment tag QR), ".01" or a flyer bag are never a
// parcel and must not start (or stop) a recording.
export type ScanVerdict =
  | { kind: 'tracking'; code: string }
  | { kind: 'invalid'; code: string; reason: string };

export const MIN_TRACKING_LENGTH = 8;
export const MAX_TRACKING_LENGTH = 40;

export function classifyScan(raw: string | null | undefined): ScanVerdict {
  const code = normalizeScannedId(raw || '');
  if (!code) return { kind: 'invalid', code, reason: 'Nothing was read — scan again.' };
  const bad = code.match(/[^A-Z0-9-]/);
  if (bad) {
    const shown = bad[0] === ' ' ? 'a space' : `"${bad[0]}"`;
    return { kind: 'invalid', code, reason: `Contains ${shown} — shipping labels never do. This looks like a product / tag code.` };
  }
  if (isFlyerBarcode(code)) {
    return { kind: 'invalid', code, reason: 'This is a flyer bag barcode — flyer scan is not used any more. Scan the parcel shipping label.' };
  }
  if (code.length < MIN_TRACKING_LENGTH) {
    return { kind: 'invalid', code, reason: `Only ${code.length} characters — a courier AWB is longer.` };
  }
  if (code.length > MAX_TRACKING_LENGTH) {
    return { kind: 'invalid', code, reason: `${code.length} characters — too long for a courier AWB.` };
  }
  const digits = (code.match(/\d/g) || []).length;
  if (digits < 5) {
    return { kind: 'invalid', code, reason: 'Not a courier AWB (too few digits).' };
  }
  return { kind: 'tracking', code };
}
