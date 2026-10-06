// Multi-item parcels on the packing page (unit-tested).
//
// A parcel with more than one unit — two SKUs, or the same SKU x2 (often two
// Meesho sub-orders of one SKU) — is where short and wrong packing happens,
// so the packing page shows a pop-up with every SKU, its photo and count.

import type { OrderLineItem } from './orderContext';

export interface ParcelSkuGroup {
  sku: string;
  title: string | null;
  imageUrl: string | null;
  // 'style' = photo of the same style in another size.
  imageMatch: 'exact' | 'style' | null;
  quantity: number;
  lines: number;
}

export interface ParcelSummary {
  units: number;
  skuCount: number;
  isMulti: boolean;
  groups: ParcelSkuGroup[];
}

// How long the pop-up stays up before it closes itself (2-3 s asked).
export const MULTI_ITEM_ALERT_MS = 3000;

export function summarizeParcel(items: OrderLineItem[] | null | undefined): ParcelSummary {
  const groups = new Map<string, ParcelSkuGroup>();
  for (const item of items || []) {
    const sku = (item.sku || 'UNKNOWN').trim() || 'UNKNOWN';
    const key = sku.toUpperCase().replace(/\s+/g, ' ');
    const quantity = Number.isFinite(item.quantity) && item.quantity > 0 ? Math.floor(item.quantity) : 1;
    const held = groups.get(key);
    if (held) {
      held.quantity += quantity;
      held.lines += 1;
      held.title = held.title || item.title || null;
      if (!held.imageUrl && item.imageUrl) {
        held.imageUrl = item.imageUrl;
        held.imageMatch = item.imageMatch ?? 'exact';
      }
    } else {
      groups.set(key, {
        sku,
        title: item.title || null,
        imageUrl: item.imageUrl || null,
        imageMatch: item.imageUrl ? item.imageMatch ?? 'exact' : null,
        quantity,
        lines: 1,
      });
    }
  }
  const list = [...groups.values()];
  const units = list.reduce((sum, group) => sum + group.quantity, 0);
  return { units, skuCount: list.length, isMulti: units > 1, groups: list };
}

export function multiItemHeadline(summary: Pick<ParcelSummary, 'units' | 'skuCount'>): string {
  const units = `${summary.units} item${summary.units === 1 ? '' : 's'}`;
  if (summary.skuCount <= 1) return `${units} of the same SKU`;
  return `${units} · ${summary.skuCount} different SKUs`;
}
