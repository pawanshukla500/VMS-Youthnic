import { describe, it, expect } from 'vitest';
import {
  pickBestVideo,
  findVideoCandidates,
  safeMarkReplied,
  type VideoCandidate,
  type AjioJobSummary,
} from '../ajio/processor';

const T0 = Date.UTC(2026, 2, 9, 6, 0, 0);
const cand = (id: string, createdOffsetMin: number | null, hasVideo = true): VideoCandidate => ({
  id,
  tracking_id: 'T1',
  order_id: 'FN1',
  marketplace: 'Ajio',
  created_at: createdOffsetMin === null ? null : new Date(T0 + createdOffsetMin * 60 * 1000).toISOString(),
  has_video: hasVideo,
  storage_path: hasVideo ? `packing-videos/x/${id}.mp4` : null,
});

describe('pickBestVideo', () => {
  it('ignores sessions with no uploaded file', () => {
    expect(pickBestVideo([cand('a', 5, false)], T0)).toBeNull();
    expect(pickBestVideo([], T0)).toBeNull();
  });

  it('prefers the session closest after packing time', () => {
    const rows = [cand('old', -120), cand('near', 10), cand('later', 90)];
    expect(pickBestVideo(rows, T0)?.id).toBe('near');
  });

  it('falls back to the most recent session before packing time', () => {
    const rows = [cand('older', -300), cand('recent', -30)];
    expect(pickBestVideo(rows, T0)?.id).toBe('recent');
  });

  it('picks the newest session when packing time is unknown', () => {
    const rows = [cand('older', -300), cand('recent', -30)];
    expect(pickBestVideo(rows, null)?.id).toBe('recent');
  });
});

describe('findVideoCandidates', () => {
  const fakePool = (mapRows: any[], sessionRows: any[]) => {
    const calls: { text: string; params: any[] }[] = [];
    return {
      calls,
      pool: {
        query: async (text: string, params: any[]) => {
          calls.push({ text, params });
          if (text.includes('marketplace_order_mappings')) return { rows: mapRows };
          return { rows: sessionRows };
        },
      } as any,
    };
  };

  it('queries nothing when no keys exist', async () => {
    const { calls, pool } = fakePool([], []);
    await expect(
      findVideoCandidates(pool, 'org', { orderId: null, shipmentId: '  ', referenceValue: null })
    ).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it('expands keys through mappings and compares case-insensitively', async () => {
    const { calls, pool } = fakePool([{ tracking_id: 'awb-1', order_id: 'fn1' }], [{ id: 's1' }]);
    const rows = await findVideoCandidates(pool, 'org', {
      orderId: ' FN1 ',
      shipmentId: null,
      referenceValue: 'rt1',
    });
    expect(rows).toEqual([{ id: 's1' }]);
    expect(calls[0].params).toEqual(['org', ['FN1', 'RT1']]);
    expect(calls[1].params).toEqual(['org', ['FN1', 'RT1', 'AWB-1']]);
    expect(calls[1].text).toContain('UPPER(BTRIM(COALESCE(rs.order_id');
  });
});

describe('safeMarkReplied', () => {
  const blankSummary = (): AjioJobSummary => ({
    checked: 0, skipped: 0, matched: 0, uploaded: 0, replied: 0,
    missing: 0, failed: 0, errors: [], warnings: [],
  });

  it('passes success through silently', async () => {
    let marked = '';
    const summary = blankSummary();
    await safeMarkReplied(
      { markReplied: async (uid: string) => { marked = uid; } },
      { uid: 'm1', subject: 's' },
      summary
    );
    expect(marked).toBe('m1');
    expect(summary.warnings).toEqual([]);
  });

  it('converts mark failures into warnings instead of throwing', async () => {
    const summary = blankSummary();
    await safeMarkReplied(
      { markReplied: async () => { throw new Error('Gmail API 403 on modify'); } },
      { uid: 'm1', subject: 'CCTV FOOTAGE REQUIRED||INC1' },
      summary
    );
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain('reply was sent');
  });
});
