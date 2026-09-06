import { describe, it, expect } from 'vitest';
import { getReportDay, buildDailyReportHtml, buildDailyReportSubject, parseReportRecipients } from '../reports/dailyReport';

describe('getReportDay', () => {
  it('builds an exact 24h IST window for an explicit date', () => {
    const { day, start, end } = getReportDay('2026-09-03');
    expect(day).toBe('2026-09-03');
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(start.toISOString()).toBe('2026-09-02T18:30:00.000Z');
  });

  it('falls back to today (IST) for garbage input', () => {
    const { day } = getReportDay('not-a-date');
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('buildDailyReportHtml', () => {
  const stats = {
    day: '2026-09-03',
    totalPacked: 1200,
    completedVideos: 1190,
    failedUploads: 10,
    operators: 6,
    avgDurationSeconds: 45.2,
    mappingsImported: 300,
    renamedToOrders: 1150,
    renamedBySubItem: 900,
    stations: [{ station: 'PACK-01', packed: 600 }],
    marketplaces: [{ marketplace: 'Amazon', packed: 900 }],
  };

  it('includes headline numbers, stations and rename count', () => {
    const html = buildDailyReportHtml(stats);
    expect(html).toContain('2026-09-03');
    expect(html).toContain('1200');
    expect(html).toContain('PACK-01');
    expect(html).toContain('Renamed to orders');
    expect(html).toContain('1150');
  });

  it('escapes untrusted strings', () => {
    const html = buildDailyReportHtml({ ...stats, stations: [{ station: '<img src=x>', packed: 1 }] });
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img src=x&gt;');
  });

  it('subject carries day and total', () => {
    expect(buildDailyReportSubject(stats)).toContain('2026-09-03');
    expect(buildDailyReportSubject(stats)).toContain('1200');
  });
});

describe('parseReportRecipients', () => {
  it('splits, trims and drops invalid entries', () => {
    expect(parseReportRecipients('admin@x.com, manager@x.com , junk')).toEqual(['admin@x.com', 'manager@x.com']);
    expect(parseReportRecipients(undefined)).toEqual([]);
  });
});
