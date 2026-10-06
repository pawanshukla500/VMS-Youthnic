// Pure helpers for the packing-station scan flow (unit-tested).

// Barcode scanners act as keyboards: strip surrounding whitespace/newlines
// the scanner or operator may add. Returns '' when nothing scannable remains.
export function normalizeScannedId(raw: string): string {
  return (raw || '').trim();
}

// A second scan of the parcel already being recorded (scanner double-read)
// must not split the session: stop + restart would cut one parcel's video
// in two. Comparison is exact after normalization; different IDs always
// start a new session.
export function isDuplicateScan(currentTrackingId: string | null | undefined, nextTrackingId: string): boolean {
  if (!currentTrackingId || !nextTrackingId) return false;
  return currentTrackingId === nextTrackingId;
}

// Meesho detection for marketplace-scoped flows (flyer capture). Mirrors
// the server's sub-order identity rule: any marketplace name containing
// "meesho" (case-insensitive). Null-safe by design.
export function isMeeshoMarketplace(marketplace: string | null | undefined): boolean {
  return typeof marketplace === 'string' && marketplace.toLowerCase().includes('meesho');
}

// Determines if a shipment is likely Meesho from either marketplace resolution
// or carrier tracking prefix. Valmo (VL...) is Meesho's proprietary delivery network.
// A resolved marketplace is the answer; the prefix only covers the moment
// before the order lookup returns (Meesho also ships Delhivery/Shadowfax).
export function isLikelyMeeshoShipment(
  trackingId: string | null | undefined,
  marketplace?: string | null | undefined
): boolean {
  if (typeof marketplace === 'string' && marketplace.trim()) return isMeeshoMarketplace(marketplace);
  if (!trackingId) return false;
  const clean = trackingId.trim().toUpperCase();
  // Valmo logistics (VL...) is Meesho's proprietary delivery network
  if (/^VL[0-9A-Z]{6,}/.test(clean)) return true;
  return false;
}

// Meesho flyer-bag capture: when an order is identified as Meesho (either by
// marketplace resolution or Valmo courier prefix), flyer scanning AUTOMATICALLY
// activates for this parcel without needing the operator to manually flip the toggle.
// For other orders, flyer scanning is required only if the manual toggle is on
// and the marketplace is not yet proven to be non-Meesho.
export function shouldRequireFlyerId(args: {
  flyerScanEnabled: boolean;
  isRecording: boolean;
  flyerId: string | null;
  flyerWaived: boolean;
  marketplaceIsMeesho: boolean;
  marketplaceKnown: boolean;
}): boolean {
  if (!args.isRecording) return false;
  if (args.flyerId || args.flyerWaived) return false;

  // Auto-activate for Meesho orders even if the operator has not enabled the manual flyer toggle
  if (args.marketplaceIsMeesho) return true;

  // For non-confirmed orders, only require flyer if the manual toggle is enabled
  if (!args.flyerScanEnabled) return false;

  // When toggle is ON, require flyer unless positively known to be non-Meesho
  return !args.marketplaceKnown;
}

// What the packing page's "Flyer scan" switch shows. Once the scanned
// parcel's marketplace is known the switch follows it automatically: ON for
// Meesho, OFF for every other marketplace. With no parcel (or an unknown
// one) it shows the operator's own per-device setting.
export function flyerToggleState(args: {
  manualEnabled: boolean;
  hasParcel: boolean;
  marketplaceKnown: boolean;
  isMeesho: boolean;
}): { on: boolean; auto: boolean } {
  if (args.hasParcel && (args.marketplaceKnown || args.isMeesho)) {
    return { on: args.isMeesho, auto: true };
  }
  return { on: args.manualEnabled, auto: false };
}

// Known Meesho Transparent Packaging (Flyer) barcodes start with 'TP'
// (e.g. TP4OOEU08339990, TP10OEU08338897). Also matches common flyer bag prefixes.
export function isFlyerBarcode(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const val = raw.trim().toUpperCase();
  if (val.length < 6) return false;
  // Meesho transparent packaging packets start with 'TP'
  if (/^TP[A-Z0-9]{4,}/.test(val)) return true;
  if (/^(PKT|FLY|BAG)[A-Z0-9]{4,}/.test(val)) return true;
  return false;
}

// Known courier tracking number / AWB patterns:
// - Valmo: VL + 10-16 digits (e.g. VL0085617258688)
// - Shadowfax: SF + digits/alphanumeric (e.g. SF4178840390MFO, SF4184553296FPL)
// - Flipkart: FMP... or FMPC...
// - Amazon: TBA...
// - Xpressbees: EXP... or DX...
// - Delhivery / Ecom / Bluedart: Pure numeric digits of length >= 10 (e.g. 1490842015571145)
export function isCourierTrackingBarcode(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const val = raw.trim().toUpperCase();
  if (val.length < 8) return false;
  if (/^(VL|SF|FMP|FMPC|TBA|EXP|DX|DEL|BLU)[A-Z0-9]+/.test(val)) return true;
  if (/^\d{10,24}$/.test(val)) return true;
  return false;
}

export type BarcodeType = 'flyer' | 'tracking' | 'unknown';

export function classifyBarcode(raw: string | null | undefined): BarcodeType {
  if (isFlyerBarcode(raw)) return 'flyer';
  if (isCourierTrackingBarcode(raw)) return 'tracking';
  return 'unknown';
}

