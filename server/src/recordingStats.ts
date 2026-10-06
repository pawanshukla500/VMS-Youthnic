// Frame-timing stats the packing page sends with every upload (unit-tested).
// Untrusted input: only known numeric fields survive, clamped, so the
// JSONB column stays small and queryable.

export interface RecordingStats {
  mode: 'worker' | 'video-frame' | 'animation-frame' | 'unknown';
  frames: number;
  cameraFps: number;
  outputFps: number;
  gaps: number;
  maxGapMs: number;
  dropped: number;
  avgComposeMs: number;
  p95ComposeMs: number;
  durationMs: number;
  width: number;
  height: number;
}

const MODES = new Set(['worker', 'video-frame', 'animation-frame']);
const LIMITS: Record<Exclude<keyof RecordingStats, 'mode'>, number> = {
  frames: 10_000_000,
  cameraFps: 240,
  outputFps: 240,
  gaps: 1_000_000,
  maxGapMs: 3_600_000,
  dropped: 10_000_000,
  avgComposeMs: 10_000,
  p95ComposeMs: 10_000,
  durationMs: 86_400_000,
  width: 10_000,
  height: 10_000,
};

export function sanitizeRecordingStats(raw: unknown): RecordingStats | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const out: Partial<RecordingStats> = {
    mode: typeof input.mode === 'string' && MODES.has(input.mode) ? (input.mode as RecordingStats['mode']) : 'unknown',
  };
  for (const [key, max] of Object.entries(LIMITS) as Array<[Exclude<keyof RecordingStats, 'mode'>, number]>) {
    const n = Number(input[key]);
    out[key] = Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n * 10) / 10)) : 0;
  }
  return (out.frames || 0) > 0 ? (out as RecordingStats) : null;
}

// Same rule as the client: frames lost, a long camera stall, or a camera
// running far below its 30 fps target.
export function isLaggyRecording(stats: RecordingStats | null | undefined): boolean {
  if (!stats || stats.frames < 30) return false;
  const dropRate = stats.dropped / Math.max(1, stats.frames + stats.dropped);
  return dropRate > 0.02 || stats.maxGapMs > 500 || (stats.cameraFps > 0 && stats.cameraFps < 15);
}
