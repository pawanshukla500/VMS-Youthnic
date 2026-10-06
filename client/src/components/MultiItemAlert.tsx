// Full-screen heads-up for a parcel with more than one item: every SKU with
// its photo and count, so the packer does not seal it short or mixed up.
// Closes itself after `durationMs`; a tap or Esc closes it sooner. It never
// takes focus — the barcode scanner keeps typing into the scan input, and
// scanning the next parcel closes it too.
import { SafeImage } from './ui';
import { multiItemHeadline, ParcelSummary } from '../utils/multiItem';

export function MultiItemAlert({
  summary,
  trackingId,
  durationMs,
  onClose,
}: {
  summary: ParcelSummary;
  trackingId: string;
  durationMs: number;
  onClose: () => void;
}) {
  const many = summary.groups.length > 3;
  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-labelledby="multi-item-title"
      aria-describedby="multi-item-headline"
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60"
      // mousedown + preventDefault: closing must not move focus off the scan input.
      onMouseDown={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className={`w-full ${many ? 'max-w-4xl' : 'max-w-2xl'} rounded-2xl bg-surface-card border-2 border-warning shadow-2xl overflow-hidden`}>
        <div className="bg-warning text-black px-5 py-3 flex items-center gap-3">
          <span className="material-symbols-outlined text-[32px]" aria-hidden="true">inventory_2</span>
          <div className="min-w-0">
            <p id="multi-item-title" className="text-xl font-extrabold uppercase tracking-wide leading-tight">
              Multi-item parcel — pack all {summary.units}
            </p>
            <p id="multi-item-headline" className="text-sm font-semibold truncate">
              {multiItemHeadline(summary)} · {trackingId}
            </p>
          </div>
        </div>

        <div className={`p-4 grid gap-3 ${many ? 'grid-cols-2 sm:grid-cols-4' : summary.groups.length === 1 ? 'grid-cols-1 max-w-xs mx-auto' : 'grid-cols-2 sm:grid-cols-3'} max-h-[62vh] overflow-y-auto`}>
          {summary.groups.map((group) => (
            <div key={group.sku} className="rounded-xl border border-border-subtle bg-surface-bg overflow-hidden">
              <div className="aspect-square bg-surface-container relative overflow-hidden">
                <SafeImage
                  src={group.imageUrl}
                  alt={group.title || group.sku}
                  fallbackIcon="package_2"
                  loading="eager"
                  className="absolute inset-0 w-full h-full object-contain text-5xl text-on-surface-variant/50"
                />
                <span className="absolute top-2 right-2 min-w-[3.25rem] px-2 py-0.5 rounded-lg bg-warning text-black text-2xl font-black text-center shadow">
                  ×{group.quantity}
                </span>
              </div>
              <div className="p-2.5">
                <p className="font-technical text-sm font-bold text-on-surface break-all">{group.sku}</p>
                {group.title && (
                  <p className="font-body-sm text-xs text-on-surface-variant mt-0.5 line-clamp-2" title={group.title}>{group.title}</p>
                )}
                {group.imageMatch === 'style' && (
                  <p className="text-[11px] font-semibold text-amber-800 mt-1">Photo shows another size</p>
                )}
                {!group.imageUrl && (
                  <p className="text-[11px] text-on-surface-variant mt-1">No photo — check the SKU code</p>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="h-1.5 bg-warning/20" aria-hidden="true">
          <div className="h-full bg-warning multi-item-countdown" style={{ animationDuration: `${durationMs}ms` }} />
        </div>
        <p className="text-center text-xs text-on-surface-variant py-2">Closes by itself · tap anywhere or press Esc to close now</p>
      </div>
    </div>
  );
}
