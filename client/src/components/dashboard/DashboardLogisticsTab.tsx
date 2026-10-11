import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  HelpCircle,
  Network,
  ScanLine,
  Search,
  ShieldCheck,
  Sparkles,
  Truck,
} from 'lucide-react';
import { Card } from '../ui';
import { CarrierBadge, CarrierDirectoryCard, PaymentGatewayDirectoryCard } from '../LogisticsBadges';
import { CARRIER_REGISTRY, CarrierBrand, detectCarrier, PAYMENT_GATEWAY_REGISTRY } from '../../utils/logisticsLogos';

export function DashboardLogisticsTab() {
  const [testAwb, setTestAwb] = useState('');
  const [carrierSearch, setCarrierSearch] = useState('');

  const detectedCarrier: CarrierBrand | null = testAwb ? detectCarrier(testAwb) : null;
  const carriers = Object.values(CARRIER_REGISTRY);

  const filteredCarriers = carriers.filter((c) => {
    if (!carrierSearch.trim()) return true;
    const q = carrierSearch.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.code.toLowerCase().includes(q) ||
      c.domain.toLowerCase().includes(q) ||
      c.trackingPrefixes.some((p) => p.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-white border border-border-subtle rounded-xl p-5 sm:p-6 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="px-2.5 py-0.5 rounded-md text-xs font-medium bg-primary/10 text-primary border border-primary/20">
              Carrier Ecosystem
            </span>
            <span className="text-secondary text-xs flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-success" /> Verified Courier Partners
            </span>
          </div>
          <h2 className="font-headline text-2xl font-bold tracking-tight text-on-surface">
            Logistics & Courier Integrations
          </h2>
          <p className="text-secondary text-xs mt-1">
            Official courier partners, automated AWB prefix recognition, and real-time tracking portals.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-success/10 text-success border border-success/20 text-xs font-medium">
            <CheckCircle2 className="w-4 h-4" />
            {carriers.length} Supported Couriers
          </span>
        </div>
      </div>

      {/* Interactive Live AWB Detector / Validator Tool */}
      <Card className="p-5 sm:p-6 bg-white border border-border-subtle shadow-2xs">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-primary text-white flex items-center justify-center">
              <ScanLine className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-headline font-bold text-base text-on-surface">
                Interactive AWB Courier Detector & Validator
              </h3>
              <p className="text-secondary text-xs">
                Scan or paste any courier AWB to verify barcode format and detect the logistics partner.
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                placeholder="e.g. VL0085617258688, SF4178840390MFO, 1490842015571145, EXP92384723..."
                value={testAwb}
                onChange={(e) => setTestAwb(e.target.value.trim())}
                className="w-full pl-4 pr-10 py-2.5 bg-white border border-border-heavy rounded-xl text-xs font-mono font-medium text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all shadow-2xs"
              />
              {testAwb && (
                <button
                  type="button"
                  onClick={() => setTestAwb('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-secondary hover:text-on-surface text-xs"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setTestAwb('VL0085617258688')}
                className="px-2.5 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-[11px] font-mono text-secondary transition-colors"
              >
                Sample Valmo
              </button>
              <button
                type="button"
                onClick={() => setTestAwb('SF4178840390MFO')}
                className="px-2.5 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-[11px] font-mono text-secondary transition-colors"
              >
                Sample Shadowfax
              </button>
              <button
                type="button"
                onClick={() => setTestAwb('1490842015571145')}
                className="px-2.5 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-[11px] font-mono text-secondary transition-colors"
              >
                Sample Delhivery
              </button>
            </div>
          </div>

          {/* Result Card */}
          {testAwb && (
            <div className="mt-4 p-4 rounded-xl border border-border-subtle bg-white shadow-xs animate-in fade-in duration-150">
              {detectedCarrier ? (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-surface-container-low border border-border-subtle p-1 flex items-center justify-center shrink-0">
                      <img
                        src={detectedCarrier.iconUrl}
                        alt={detectedCarrier.name}
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-headline font-bold text-base text-on-surface">
                          {detectedCarrier.name}
                        </span>
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-success/10 text-success border border-success/20">
                          Identified Partner
                        </span>
                      </div>
                      <p className="text-secondary text-xs mt-0.5">
                        Matched prefix in tracking pattern · Domain:{' '}
                        <span className="font-mono text-primary">{detectedCarrier.domain}</span>
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-start sm:self-auto">
                    <a
                      href={detectedCarrier.trackingUrl(testAwb)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3.5 py-2 rounded-xl bg-primary text-white font-medium text-xs flex items-center gap-1.5 hover:bg-primary/90 transition-all shadow-xs"
                    >
                      Track on Portal <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-warning text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>
                    No specific courier recognized for &quot;{testAwb}&quot;. It will default to standard dispatch tracking.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Carrier Directory Grid */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="font-headline font-bold text-base text-on-surface">
              Connected Logistics Partners
            </h3>
            <p className="text-secondary text-xs">
              Showing official logos, supported AWB prefixes, and documentation.
            </p>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-secondary absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Filter carriers or prefix..."
              value={carrierSearch}
              onChange={(e) => setCarrierSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 bg-white border border-border-heavy rounded-xl text-xs text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all shadow-2xs"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredCarriers.map((carrier) => (
            <CarrierDirectoryCard key={carrier.code} carrier={carrier} />
          ))}
        </div>
      </div>

      {/* Payment Gateways & Checkout Integrations */}
      <div className="space-y-4 pt-4 border-t border-border-subtle">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="px-2.5 py-0.5 rounded-md text-xs font-medium bg-indigo-500/10 text-indigo-700 border border-indigo-500/20">
                Payment Rails & Settlement
              </span>
              <span className="text-secondary text-xs flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-success" /> Brandfetch Verified
              </span>
            </div>
            <h3 className="font-headline font-bold text-base text-on-surface">
              Payment Gateways & Instant Refunds
            </h3>
            <p className="text-secondary text-xs">
              GoKwik, Easebuzz, PhonePe, and integrated checkout providers powering prepaid settlements and automated customer refunds.
            </p>
          </div>

          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-container text-secondary text-xs font-medium self-start sm:self-auto">
            <CreditCard className="w-3.5 h-3.5 text-primary" />
            {Object.keys(PAYMENT_GATEWAY_REGISTRY).length} Supported Gateways
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {Object.values(PAYMENT_GATEWAY_REGISTRY).map((gateway) => (
            <PaymentGatewayDirectoryCard key={gateway.code} gateway={gateway} />
          ))}
        </div>
      </div>
    </div>
  );
}
