import React from 'react';
import { ExternalLink, CheckCircle2, ShieldCheck } from 'lucide-react';
import { CarrierBrand, MarketplaceBrand, CARRIER_REGISTRY, detectCarrier, getMarketplaceBrand } from '../utils/logisticsLogos';

interface CarrierBadgeProps {
  trackingId?: string | null;
  carrierCode?: string | null;
  carrier?: CarrierBrand | null;
  showLogo?: boolean;
  linkable?: boolean;
  className?: string;
  size?: 'xs' | 'sm' | 'md';
}

export function CarrierBadge({
  trackingId,
  carrierCode,
  carrier,
  showLogo = true,
  linkable = true,
  className = '',
  size = 'sm',
}: CarrierBadgeProps) {
  const resolvedCarrier: CarrierBrand | null =
    carrier ||
    (carrierCode ? CARRIER_REGISTRY[carrierCode.toLowerCase()] : null) ||
    (trackingId ? detectCarrier(trackingId) : null);

  if (!resolvedCarrier) {
    if (!trackingId && !carrierCode) return null;
    return (
      <span
        className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-md bg-surface-container text-secondary border border-border-subtle ${className}`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-outline/50" />
        {carrierCode ? carrierCode.toUpperCase() : 'Standard Courier'}
      </span>
    );
  }

  const badgeContent = (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md font-medium border transition-colors shadow-2xs ${
        size === 'xs' ? 'px-1.5 py-0.5 text-[11px]' : size === 'md' ? 'px-3 py-1.5 text-xs' : 'px-2 py-0.5 text-xs'
      } bg-white text-on-surface border-border-heavy hover:border-primary/40 ${className}`}
    >
      {showLogo && (
        <span className="w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 overflow-hidden bg-surface-container-low">
          <img
            src={resolvedCarrier.iconUrl}
            alt={resolvedCarrier.name}
            className="w-full h-full object-contain"
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLElement).style.display = 'none';
            }}
          />
        </span>
      )}
      <span className="font-semibold">{resolvedCarrier.name}</span>
      {linkable && trackingId && (
        <ExternalLink className="w-3 h-3 text-secondary opacity-60 hover:opacity-100 shrink-0" aria-hidden />
      )}
    </span>
  );

  if (linkable && trackingId) {
    return (
      <a
        href={resolvedCarrier.trackingUrl(trackingId)}
        target="_blank"
        rel="noopener noreferrer"
        title={`Track ${trackingId} on ${resolvedCarrier.name}`}
        className="inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md"
      >
        {badgeContent}
      </a>
    );
  }

  return badgeContent;
}

interface MarketplaceLogoBadgeProps {
  marketplace: string | null | undefined;
  showLogo?: boolean;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

export function MarketplaceLogoBadge({
  marketplace,
  showLogo = true,
  size = 'sm',
  className = '',
}: MarketplaceLogoBadgeProps) {
  const brand = getMarketplaceBrand(marketplace);

  if (!brand) {
    return (
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-surface-container text-secondary border border-border-subtle ${className}`}
      >
        {marketplace || 'Unassigned'}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md font-medium border transition-colors ${
        size === 'xs' ? 'px-1.5 py-0.5 text-[11px]' : size === 'md' ? 'px-3 py-1 text-xs' : 'px-2 py-0.5 text-xs'
      } bg-white border-border-heavy text-on-surface shadow-2xs ${className}`}
    >
      {showLogo && (
        <span className="w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 overflow-hidden bg-surface-container-low">
          <img
            src={brand.iconUrl}
            alt={brand.name}
            className="w-full h-full object-contain"
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLElement).style.display = 'none';
            }}
          />
        </span>
      )}
      <span className="font-semibold">{brand.name}</span>
    </span>
  );
}

export function CarrierDirectoryCard({ carrier }: { carrier: CarrierBrand }) {
  return (
    <div className="bg-white border border-border-subtle rounded-xl p-5 hover:border-primary/50 hover:shadow-sm transition-all flex flex-col justify-between group">
      <div>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="h-9 w-28 bg-surface-bg rounded p-1 flex items-center justify-start overflow-hidden border border-border-subtle/60">
            <img
              src={carrier.logoUrl}
              alt={carrier.name}
              className="max-h-full max-w-full object-contain"
              loading="lazy"
              onError={(e) => {
                const target = e.currentTarget;
                if (!target.dataset.triedFallback) {
                  target.dataset.triedFallback = 'true';
                  target.src = carrier.iconUrl;
                } else {
                  target.style.display = 'none';
                }
              }}
            />
          </div>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-success/10 text-success border border-success/20">
            <CheckCircle2 className="w-3 h-3" />
            Active
          </span>
        </div>

        <h4 className="font-headline font-bold text-on-surface text-base mb-1">{carrier.name}</h4>
        <p className="text-secondary text-xs line-clamp-2 leading-relaxed mb-3">{carrier.description}</p>

        <div className="space-y-1.5 text-xs border-t border-border-subtle/80 pt-3">
          <div className="flex items-center justify-between text-secondary">
            <span>AWB Prefixes:</span>
            <span className="font-mono text-on-surface font-medium bg-surface-container-low px-1.5 py-0.5 rounded text-[11px]">
              {carrier.trackingPrefixes.join(', ')}
            </span>
          </div>
          <div className="flex items-center justify-between text-secondary">
            <span>Domain:</span>
            <span className="font-mono text-[11px] text-primary">{carrier.domain}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-border-subtle flex items-center justify-between">
        <span className="text-[11px] text-secondary flex items-center gap-1">
          <ShieldCheck className="w-3.5 h-3.5 text-success" /> Brandfetch Verified
        </span>
        <a
          href={`https://${carrier.domain}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-semibold text-primary hover:underline flex items-center gap-1"
        >
          Portal <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}
