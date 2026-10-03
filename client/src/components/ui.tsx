// Shared UI primitives: one visual language for every page.
// Pages must compose these instead of inventing their own cards/badges.
// Theme tokens come from tailwind.config.js (surface-*, on-*, primary…).
import React, { useEffect, useState } from 'react';

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <header className="bg-surface-container-lowest flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
      <div className="min-w-0">
        <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">{title}</h2>
        {description && <p className="font-body-sm text-body-sm text-secondary">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-surface-card rounded-lg border border-border-subtle shadow-sm overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ icon, title, description, action }: { icon: string; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="p-5 border-b border-border-subtle bg-surface-container-lowest flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
          <span className="material-symbols-outlined">{icon}</span>
        </div>
        <div className="min-w-0">
          <h3 className="font-headline-2 text-headline-2 text-on-surface">{title}</h3>
          {description && <p className="font-body-sm text-body-sm text-secondary">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  ok: 'bg-success/10 text-success border-success/20',
  uploaded: 'bg-success/10 text-success border-success/20',
  completed: 'bg-success/10 text-success border-success/20',
  resolved: 'bg-success/10 text-success border-success/20',
  active: 'bg-success/10 text-success border-success/20',
  warn: 'bg-warning/10 text-warning border-warning/20',
  pending: 'bg-warning/10 text-warning border-warning/20',
  uploading: 'bg-warning/10 text-warning border-warning/20',
  fail: 'bg-critical/10 text-critical border-critical/20',
  failed: 'bg-critical/10 text-critical border-critical/20',
  disputed: 'bg-critical/10 text-critical border-critical/20',
  info: 'bg-primary/10 text-primary border-primary/20',
};

export function StatusBadge({ status, pulse = false }: { status: string; pulse?: boolean }) {
  const key = (status || 'pending').toLowerCase();
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-bold tracking-wide border ${STATUS_TONE[key] || STATUS_TONE.info}`}>
      {pulse && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>}
      {String(status || 'pending').toUpperCase()}
    </span>
  );
}

export function StatCard({ title, value, sub, icon, color = 'text-primary' }: { title: string; value: React.ReactNode; sub?: string; icon: string; color?: string }) {
  return (
    <div className="bg-surface-card border border-border-subtle rounded-2xl p-6 shadow-sm hover:shadow-md transition-shadow group flex items-center justify-between">
      <div className="min-w-0">
        <p className="font-metadata text-metadata text-secondary uppercase tracking-wider mb-2">{title}</p>
        <p className={`font-headline-1 text-3xl font-bold ${color}`}>{value}</p>
        {sub && <p className="font-body-sm text-body-sm text-secondary mt-1">{sub}</p>}
      </div>
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center opacity-80 group-hover:opacity-100 transition-opacity bg-surface-container shrink-0 ${color}`}>
        <span className="material-symbols-outlined text-2xl">{icon}</span>
      </div>
    </div>
  );
}

export function EmptyState({ icon = 'inbox', title, hint, action }: { icon?: string; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center p-10 gap-2">
      <span className="material-symbols-outlined text-4xl text-on-surface-variant/50">{icon}</span>
      <p className="font-headline-2 text-headline-2 text-on-surface">{title}</p>
      {hint && <p className="font-body-sm text-body-sm text-secondary max-w-sm">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// SafeImage: the only <img> wrapper we ship.
//
// Why this exists: every previous <img> in this codebase used
// `onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}`.
// That worked but it (1) hides the image with an inline style, leaking layout
// size, (2) mutates the DOM directly, (3) makes the fallback icon shrink to
// zero, (4) keeps firing onError on every render until the parent re-renders.
//
// This wrapper tracks state, shows a real fallback icon, and resets cleanly if
// the src ever changes (e.g. switching SKUs in the packing grid). The fallback
// is rendered as a real positioned element so callers can use `absolute`,
// `object-cover`, etc. without leaking layout.
export function SafeImage({
  src,
  alt,
  className = '',
  fallbackIcon = 'image_not_supported',
  loading = 'lazy',
  decoding = 'async',
  draggable = false,
}: {
  src?: string | null;
  alt: string;
  className?: string;
  fallbackIcon?: string;
  loading?: 'eager' | 'lazy';
  decoding?: 'async' | 'sync' | 'auto';
  draggable?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  // Reset failure flag whenever the src changes — switching SKUs in the
  // packing grid would otherwise leave a previously-broken src flagged.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    return (
      <span
        role="img"
        aria-label={alt}
        className={`flex items-center justify-center bg-surface-container text-on-surface-variant/60 ${className}`}
      >
        <span className="material-symbols-outlined" aria-hidden="true">{fallbackIcon}</span>
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading={loading}
      decoding={decoding}
      draggable={draggable}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
