import { describe, it, expect } from 'vitest';
import { flyerLinkupState, flyerSkipReason, holdFlyerIfLinkupOff, istDateString } from '../meeshoFlyer';

// 2026-10-07 10:00 IST = 04:30 UTC.
const NOW = Date.parse('2026-10-07T04:30:00Z');

describe('flyer link-up switch', () => {
  it('uses the IST calendar day', () => {
    expect(istDateString(Date.parse('2026-10-06T18:29:00Z'))).toBe('2026-10-06'); // 23:59 IST
    expect(istDateString(Date.parse('2026-10-06T18:31:00Z'))).toBe('2026-10-07'); // 00:01 IST
  });

  it('is on by default and when no row exists', () => {
    expect(flyerLinkupState(null, NOW)).toMatchObject({ enabled: true, skippedToday: false, active: true, today: '2026-10-07' });
    expect(flyerLinkupState({ flyer_linkup_enabled: null }, NOW).active).toBe(true);
  });

  it('off = not active; skip today = not active only today', () => {
    expect(flyerLinkupState({ flyer_linkup_enabled: false }, NOW)).toMatchObject({ enabled: false, active: false });
    expect(flyerLinkupState({ flyer_linkup_enabled: true, flyer_linkup_skip_date: '2026-10-07' }, NOW))
      .toMatchObject({ skippedToday: true, active: false, skipDate: '2026-10-07' });
    // Yesterday's skip no longer applies: link-up resumes by itself.
    expect(flyerLinkupState({ flyer_linkup_enabled: true, flyer_linkup_skip_date: '2026-10-06' }, NOW))
      .toMatchObject({ skippedToday: false, active: true });
  });

  it('holds back flyers recorded while off or on the skipped day only', () => {
    const off = flyerLinkupState({ flyer_linkup_enabled: false }, NOW);
    expect(flyerSkipReason(off, NOW)).toMatchObject({ skippedDay: null });
    // Switched off at 10:00 IST: a 09:00 recording (re-)uploaded later keeps waiting.
    const offAt10 = flyerLinkupState({ flyer_linkup_enabled: false, flyer_linkup_changed_at: '2026-10-07T04:30:00Z' }, NOW);
    expect(flyerSkipReason(offAt10, Date.parse('2026-10-07T03:30:00Z'))).toBeNull();
    expect(flyerSkipReason(offAt10, Date.parse('2026-10-07T05:00:00Z'))).toMatchObject({ skippedDay: null });
    const skip = flyerLinkupState({ flyer_linkup_enabled: true, flyer_linkup_skip_date: '2026-10-07' }, NOW);
    expect(flyerSkipReason(skip, NOW)).toMatchObject({ skippedDay: '2026-10-07' });
    expect(flyerSkipReason(skip, NOW)?.remark).toContain('2026-10-07');
    // Recorded yesterday, uploaded today: not part of today's skip.
    expect(flyerSkipReason(skip, Date.parse('2026-10-06T10:00:00Z'))).toBeNull();
    expect(flyerSkipReason(flyerLinkupState(null, NOW), NOW)).toBeNull();
  });

  it('marks a saved recording SKIPPED only when link-up is off for it', async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const poolFor = (row: any) => ({
      query: async (sql: string, params: any[]) => {
        calls.push({ sql, params });
        if (/FROM meesho_settings/.test(sql)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        return { rows: [], rowCount: 1 };
      },
    }) as any;

    calls.length = 0;
    expect(await holdFlyerIfLinkupOff(poolFor({ flyer_linkup_enabled: true }), 'org', 'rec-1', Date.now())).toBe(false);
    expect(calls.some((c) => /UPDATE recording_sessions/.test(c.sql))).toBe(false);

    calls.length = 0;
    expect(await holdFlyerIfLinkupOff(poolFor({ flyer_linkup_enabled: false }), 'org', 'rec-2', Date.now())).toBe(true);
    const update = calls.find((c) => /UPDATE recording_sessions/.test(c.sql))!;
    expect(update.sql).toContain("flyer_link_status = 'SKIPPED'");
    // Never overrides a flyer that is already linked / failed.
    expect(update.sql).toContain("COALESCE(flyer_link_status, 'PENDING') = 'PENDING'");
    expect(update.params.slice(0, 3)).toEqual(['rec-2', 'org', null]);
  });
});
