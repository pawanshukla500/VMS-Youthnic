import { describe, it, expect } from 'vitest';
import { pickBestVideo, type VideoCandidate } from '../ajio/processor';

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
