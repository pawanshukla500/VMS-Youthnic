import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  parseReportDayRange,
  buildVideosReportWhere,
  formatIstDateTime,
  durationSeconds,
  normalizeReportStatus,
  resolveAppBaseUrl,
  buildVideosReportWorkbook,
} from '../videoReport';

describe('parseReportDayRange', () => {
  // 2026-09-09 12:00 UTC = 17:30 IST, so the IST "today" is Sep 9.
  const noonSep9Utc = Date.UTC(2026, 8, 9, 12, 0, 0);

  it('defaults to the last 7 IST days', () => {
    const range = parseReportDayRange(undefined, undefined, noonSep9Utc);
    if ('error' in range) throw new Error('expected a range');
    expect(range.fromKey).toBe('2026-09-03');
    expect(range.toKey).toBe('2026-09-09');
    expect(range.startUtc.toISOString()).toBe('2026-09-02T18:30:00.000Z');
    expect(range.endUtc.toISOString()).toBe('2026-09-09T18:30:00.000Z');
  });

  it('bounds an explicit day to IST midnight edges', () => {
    const range = parseReportDayRange('2026-09-09', '2026-09-09', noonSep9Utc);
    if ('error' in range) throw new Error('expected a range');
    expect(range.startUtc.toISOString()).toBe('2026-09-08T18:30:00.000Z');
    expect(range.endUtc.toISOString()).toBe('2026-09-09T18:30:00.000Z');
  });

  it('rejects bad dates, reversed ranges, and huge windows', () => {
    expect(parseReportDayRange('09-09-2026', undefined, noonSep9Utc)).toMatchObject({ error: expect.any(String) });
    expect(parseReportDayRange('2026-02-30', undefined, noonSep9Utc)).toMatchObject({ error: expect.any(String) });
    expect(parseReportDayRange('2026-09-10', '2026-09-09', noonSep9Utc)).toMatchObject({ error: expect.any(String) });
    expect(parseReportDayRange('2024-01-01', '2026-09-09', noonSep9Utc)).toMatchObject({ error: expect.any(String) });
  });
});

describe('buildVideosReportWhere', () => {
  it('mirrors the list filters plus IST date bounds', () => {
    const params: any[] = ['org-1'];
    const where = buildVideosReportWhere(
      {
        search: 'MYEP',
        station: 'PACK-01',
        marketplace: 'Meesho',
        reviewStatus: 'uploaded',
        startUtc: new Date('2026-09-02T18:30:00Z'),
        endUtc: new Date('2026-09-09T18:30:00Z'),
      },
      params
    );
    expect(where).toContain('va.organization_id = $1');
    expect(where).toContain('rs.tracking_id ILIKE $2');
    expect(where).toContain(`va.upload_status = 'uploaded' OR va.upload_status = 'completed'`);
    expect(where).toContain('s.code = $3');
    expect(where).toContain('LOWER(rs.marketplace) = LOWER($4)');
    expect(where).toContain('rs.created_at >= $5 AND rs.created_at < $6');
    expect(params[0]).toBe('org-1');
    expect(params[1]).toBe('%MYEP%');
    expect(params[2]).toBe('PACK-01');
    expect(params[3]).toBe('Meesho');
    expect(params[4]).toEqual(new Date('2026-09-02T18:30:00Z'));
    expect(params[5]).toEqual(new Date('2026-09-09T18:30:00Z'));
  });

  it('uses the station id for UUIDs and Unassigned for blank marketplaces', () => {
    const params: any[] = ['org-1'];
    const where = buildVideosReportWhere(
      {
        station: '1678d80c-1234-4abc-8def-1234567890ab',
        marketplace: 'Unassigned',
        startUtc: new Date('2026-09-02T18:30:00Z'),
        endUtc: new Date('2026-09-09T18:30:00Z'),
      },
      params
    );
    expect(where).toContain('rs.station_id = $2');
    expect(where).toContain(`rs.marketplace IS NULL OR rs.marketplace = ''`);
  });
});

describe('report cells', () => {
  it('formats IST datetimes like the library', () => {
    expect(formatIstDateTime(new Date('2026-09-09T04:11:47Z'))).toBe('09 Sep 2026, 09:41 AM');
    expect(formatIstDateTime(null)).toBe('');
    expect(formatIstDateTime('not-a-date')).toBe('');
  });

  it('reports whole seconds, never milliseconds', () => {
    expect(durationSeconds('133000')).toBe(133);
    expect(durationSeconds(28000)).toBe(28);
    expect(durationSeconds(23500)).toBe(24);
    expect(durationSeconds(null)).toBeNull();
    expect(durationSeconds('nope')).toBeNull();
  });

  it('normalizes statuses like the library', () => {
    expect(normalizeReportStatus('completed')).toBe('uploaded');
    expect(normalizeReportStatus('failed')).toBe('failed');
    expect(normalizeReportStatus(null)).toBe('');
  });

  it('resolves the app base from referer, origin, config, then host', () => {
    expect(resolveAppBaseUrl({ referer: 'https://vms.youthnic.shop/videos?page=2' }, '')).toBe('https://vms.youthnic.shop');
    expect(resolveAppBaseUrl({ origin: 'https://vms.youthnic.shop' }, '')).toBe('https://vms.youthnic.shop');
    expect(resolveAppBaseUrl({}, 'https://vms.youthnic.shop, http://localhost:8080')).toBe('https://vms.youthnic.shop');
    expect(resolveAppBaseUrl({ host: 'vms.youthnic.shop' }, '')).toBe('https://vms.youthnic.shop');
    expect(resolveAppBaseUrl({}, '')).toBe('');
  });
});

describe('buildVideosReportWorkbook', () => {
  const rows = [
    {
      id: 'vid-1',
      tracking_id: '372415068426',
      order_id: '403-5545330-6929166',
      marketplace: 'Amazon Flex',
      flyer_id: 'FLY-9',
      timestamp: new Date('2026-09-09T04:11:47Z'),
      duration_ms: '133000',
      packer_name: null,
      packer_email: 'packer@shop.com',
      station_code: 'PS-1',
      station_name: 'Station 1',
      upload_status: 'completed',
    },
  ];

  function sheet() {
    const workbook = buildVideosReportWorkbook(rows, 'https://vms.youthnic.shop');
    const ws = workbook.getWorksheet('Videos');
    if (!ws) throw new Error('missing Videos sheet');
    return ws;
  }

  it('lays out typed columns with a styled header', () => {
    const ws = sheet();
    expect(ws.columns.map((c) => (c as ExcelJS.Column).header)).toEqual([
      'Tracking ID', 'Order ID', 'Marketplace', 'Flyer ID', 'Date & Time (IST)',
      'Duration (sec)', 'Packer', 'Station', 'Status', 'Video Link',
    ]);
    expect(ws.getRow(1).font).toMatchObject({ bold: true });
  });

  it('writes seconds, IST text, mapped status, and a clickable link', () => {
    const ws = sheet();
    const values = ws.getRow(2).values as any[];
    expect(values[1]).toBe('372415068426');
    expect(values[2]).toBe('403-5545330-6929166');
    expect(values[4]).toBe('FLY-9');
    expect(values[5]).toBe('09 Sep 2026, 09:41 AM');
    expect(values[6]).toBe(133);
    expect(values[7]).toBe('packer@shop.com');
    expect(values[9]).toBe('uploaded');
    expect(ws.getRow(2).getCell(10).value).toEqual({
      text: 'Open video',
      hyperlink: 'https://vms.youthnic.shop/api/videos/vid-1/download',
    });
  });

  it('serializes to a real xlsx buffer', async () => {
    const workbook = buildVideosReportWorkbook(rows, 'https://vms.youthnic.shop');
    const buffer = await workbook.xlsx.writeBuffer();
    expect(buffer.byteLength).toBeGreaterThan(1000);
  }, 15000);
});
