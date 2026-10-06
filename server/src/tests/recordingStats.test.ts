import { describe, it, expect } from 'vitest';
import { isLaggyRecording, sanitizeRecordingStats } from '../recordingStats';
import { processHealthWarnings, sampleProcessHealth } from '../monitoring';

const smooth = {
  mode: 'worker', frames: 900, cameraFps: 29.9, outputFps: 29.9, gaps: 0, maxGapMs: 40,
  dropped: 0, avgComposeMs: 2.1, p95ComposeMs: 3.5, durationMs: 30000, width: 1920, height: 1080,
};

describe('sanitizeRecordingStats', () => {
  it('keeps known numeric fields only, clamped and rounded', () => {
    const out = sanitizeRecordingStats({ ...smooth, avgComposeMs: 2.1234, evil: '<script>', frames: '900' });
    expect(out).toEqual({ ...smooth, avgComposeMs: 2.1 });
    expect(Object.keys(out!)).not.toContain('evil');
  });

  it('rejects junk and unknown modes', () => {
    expect(sanitizeRecordingStats(null)).toBeNull();
    expect(sanitizeRecordingStats('x')).toBeNull();
    expect(sanitizeRecordingStats([1, 2])).toBeNull();
    expect(sanitizeRecordingStats({ frames: 0 })).toBeNull();
    expect(sanitizeRecordingStats({ ...smooth, mode: 'hacker', cameraFps: -5, maxGapMs: 1e12 }))
      .toMatchObject({ mode: 'unknown', cameraFps: 0, maxGapMs: 3_600_000 });
  });
});

describe('isLaggyRecording', () => {
  it('flags dropped frames, long camera stalls and very low camera fps', () => {
    expect(isLaggyRecording(sanitizeRecordingStats(smooth))).toBe(false);
    expect(isLaggyRecording(sanitizeRecordingStats({ ...smooth, dropped: 40 }))).toBe(true);
    expect(isLaggyRecording(sanitizeRecordingStats({ ...smooth, maxGapMs: 800 }))).toBe(true);
    expect(isLaggyRecording(sanitizeRecordingStats({ ...smooth, cameraFps: 12 }))).toBe(true);
    // Too short to judge.
    expect(isLaggyRecording(sanitizeRecordingStats({ ...smooth, frames: 10, dropped: 5 }))).toBe(false);
  });
});

describe('process monitor', () => {
  it('samples memory and warns only past thresholds', () => {
    const health = sampleProcessHealth();
    expect(health.rssMb).toBeGreaterThan(0);
    expect(health.sampledAt).not.toBeNull();
    expect(processHealthWarnings({ ...health, eventLoopP99Ms: 10, rssMb: 100 }, { eventLoopP99Ms: 200, rssMb: 450 })).toEqual([]);
    const warnings = processHealthWarnings({ ...health, eventLoopP99Ms: 350, eventLoopMaxMs: 900, rssMb: 600 }, { eventLoopP99Ms: 200, rssMb: 450 });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('event loop p99 350 ms');
    expect(warnings[1]).toContain('memory rss 600 MB');
  });
});
