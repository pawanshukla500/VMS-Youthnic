import { describe, it, expect } from 'vitest';
import { multiItemHeadline, summarizeParcel } from '../utils/multiItem';

describe('summarizeParcel', () => {
  it('single unit is not multi', () => {
    const s = summarizeParcel([{ sku: 'A_M', quantity: 1, imageUrl: 'https://x/a.jpg' }]);
    expect(s).toMatchObject({ units: 1, skuCount: 1, isMulti: false });
  });

  it('same SKU x2 on one line or two lines is multi', () => {
    expect(summarizeParcel([{ sku: 'A_M', quantity: 2 }])).toMatchObject({ units: 2, skuCount: 1, isMulti: true });
    const twoLines = summarizeParcel([
      { sku: 'a_m', quantity: 1, imageUrl: null },
      { sku: 'A_M ', quantity: 1, imageUrl: 'https://x/a.jpg', title: 'Kurti' },
    ]);
    expect(twoLines).toMatchObject({ units: 2, skuCount: 1, isMulti: true });
    expect(twoLines.groups[0]).toMatchObject({ quantity: 2, lines: 2, imageUrl: 'https://x/a.jpg', title: 'Kurti', imageMatch: 'exact' });
  });

  it('different SKUs are grouped with their counts and photo match', () => {
    const s = summarizeParcel([
      { sku: 'A_M', quantity: 1 },
      { sku: 'B_L', quantity: 3, imageUrl: 'https://x/b.jpg', imageMatch: 'style' },
    ]);
    expect(s).toMatchObject({ units: 4, skuCount: 2, isMulti: true });
    expect(s.groups.map((g) => [g.sku, g.quantity, g.imageMatch])).toEqual([['A_M', 1, null], ['B_L', 3, 'style']]);
  });

  it('bad quantities count as one and empty input is safe', () => {
    expect(summarizeParcel([{ sku: '', quantity: 0 }, { sku: 'X', quantity: Number.NaN }]).units).toBe(2);
    expect(summarizeParcel(null)).toMatchObject({ units: 0, isMulti: false, groups: [] });
  });

  it('headline reads well for both cases', () => {
    expect(multiItemHeadline({ units: 2, skuCount: 1 })).toBe('2 items of the same SKU');
    expect(multiItemHeadline({ units: 3, skuCount: 2 })).toBe('3 items · 2 different SKUs');
  });
});
