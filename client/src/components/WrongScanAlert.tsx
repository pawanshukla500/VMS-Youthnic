// Red heads-up when the scanner read something that is not a shipping label
// (garment tag QR, product sticker, a stray ".01", a flyer bag). Nothing is
// recorded or stopped for it. Closes itself; tap / Esc / the next scan close
// it sooner. Never takes focus away from the scan input.
export const WRONG_SCAN_ALERT_MS = 3000;

export function WrongScanAlert({
  code,
  reason,
  onClose,
}: {
  code: string;
  reason: string;
  onClose: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-labelledby="wrong-scan-title"
      aria-describedby="wrong-scan-reason"
      className="fixed inset-0 z-[75] flex items-center justify-center p-4 bg-black/60"
      onMouseDown={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl bg-surface-card border-2 border-critical shadow-2xl overflow-hidden">
        <div className="bg-critical text-white px-5 py-3 flex items-center gap-3">
          <span className="material-symbols-outlined text-[32px]" aria-hidden="true">block</span>
          <p id="wrong-scan-title" className="text-xl font-extrabold uppercase tracking-wide leading-tight">
            Wrong barcode scanned
          </p>
        </div>
        <div className="p-5 space-y-3">
          <p className="font-technical text-lg font-bold text-on-surface break-all bg-surface-container rounded-lg px-3 py-2">
            {code || '(empty)'}
          </p>
          <p id="wrong-scan-reason" className="text-sm text-on-surface">{reason}</p>
          <p className="text-sm font-semibold text-on-surface">
            Scan the courier AWB on the shipping label (e.g. VL…, SF…, FMP… or the long number).
          </p>
          <p className="text-xs text-on-surface-variant">Nothing was recorded for this scan.</p>
        </div>
        <div className="h-1.5 bg-critical/20" aria-hidden="true">
          <div className="h-full bg-critical multi-item-countdown" style={{ animationDuration: `${WRONG_SCAN_ALERT_MS}ms` }} />
        </div>
      </div>
    </div>
  );
}
