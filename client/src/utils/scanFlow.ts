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
