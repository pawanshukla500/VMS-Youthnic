// Burned-in watermark + frame-timing stats shared by the recording
// compositor worker and the main-thread fallback (pure parts unit-tested).

export type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface WatermarkMeta {
  stationId: string;
  stationName: string | null;
  trackingId: string;
}

// Line 2 shows the human packing-station name — never the operator email.
export function buildWatermarkLines(args: { stationId: string; stationName?: string | null; trackingId: string; time: string }): [string, string] {
  const station = args.stationName?.trim() || args.stationId;
  return [
    `STATION  ${args.stationId}   •   TRACKING  ${args.trackingId || 'IDLE'}`,
    `${station}   •   ${args.time}`,
  ];
}

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
};
let timeFormatter: Intl.DateTimeFormat | null = null;

// Same text as the old `toLocaleString('en-GB', …)`, with one cached formatter
// (creating one per frame was measurable at 30 fps).
export function formatWatermarkTime(date: Date): string {
  timeFormatter = timeFormatter || new Intl.DateTimeFormat('en-GB', TIME_FORMAT);
  return timeFormatter.format(date);
}

export interface WatermarkFonts {
  label: string;
  mono: string;
}

export function watermarkFontSize(canvasWidth: number): number {
  return Math.min(22, Math.max(13, Math.round(canvasWidth / 80)));
}

// Draws the translucent pill with both lines. The pill width is measured
// against a fixed-width time template so it does not twitch every second.
export function drawWatermark(ctx: Canvas2D, canvasWidth: number, lines: [string, string], families: WatermarkFonts) {
  const pad = Math.max(8, Math.round(canvasWidth * 0.012));
  const fontSize = watermarkFontSize(canvasWidth);
  const lineHeight = Math.round(fontSize * 1.4);
  const fonts = [`600 ${fontSize}px ${families.label}`, `500 ${fontSize}px ${families.mono}`];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const widths = lines.map((line, i) => {
    ctx.font = fonts[i];
    // Digits are proportional in Inter: measure line 2 with 0s in place of
    // the clock digits so the pill keeps one width.
    return ctx.measureText(i === 1 ? line.replace(/\d/g, '0') : line).width;
  });
  const pillX = pad;
  const pillY = pad;
  const pillW = Math.max(...widths) + pad * 1.1;
  const pillH = lineHeight * lines.length + pad * 0.8;
  const radius = Math.min(10, Math.round(fontSize * 0.45));

  ctx.fillStyle = 'rgba(8, 12, 24, 0.5)';
  ctx.beginPath();
  if (typeof (ctx as CanvasRenderingContext2D).roundRect === 'function') {
    (ctx as CanvasRenderingContext2D).roundRect(pillX, pillY, pillW, pillH, radius);
  } else {
    ctx.rect(pillX, pillY, pillW, pillH);
  }
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 4;
  lines.forEach((line, i) => {
    ctx.font = fonts[i];
    ctx.fillText(line, pillX + pad * 0.6, pillY + pad * 0.45 + i * lineHeight);
  });
  ctx.shadowBlur = 0;
  return { width: Math.ceil(pillX + pillW + 2), height: Math.ceil(pillY + pillH + 2) };
}

// ---------------------------------------------------------------- stats --

export type CompositorMode = 'worker' | 'video-frame' | 'animation-frame';

export interface RecordingStats {
  mode: CompositorMode;
  frames: number;
  // Camera frame timing (true capture timestamps).
  cameraFps: number;
  // Frames that left the compositor towards the encoder.
  outputFps: number;
  // Camera gaps longer than 2.5 frame intervals (camera stalls / USB hiccups).
  gaps: number;
  maxGapMs: number;
  // Frames the compositor dropped because it could not keep up.
  dropped: number;
  avgComposeMs: number;
  p95ComposeMs: number;
  durationMs: number;
  width: number;
  height: number;
}

// Rolling accumulator: O(1) per frame, bounded memory (compose-time
// histogram in 0.5 ms buckets up to 100 ms).
export class FrameStats {
  private frames = 0;
  private dropped = 0;
  private firstTs: number | null = null;
  private lastTs: number | null = null;
  private intervals: number[] = [];
  private gaps = 0;
  private maxGapMs = 0;
  private composeTotal = 0;
  private composeHist = new Uint32Array(201);
  private outFirstMs: number | null = null;
  private outLastMs: number | null = null;
  private outFrames = 0;

  constructor(private mode: CompositorMode, private width: number, private height: number) {}

  // tsMs: capture timestamp of the camera frame, composeMs: time spent
  // drawing it, wallMs: when it was handed to the encoder.
  frame(tsMs: number, composeMs: number, wallMs: number) {
    this.frames += 1;
    if (this.lastTs !== null) {
      const delta = tsMs - this.lastTs;
      if (delta > 0) {
        if (this.intervals.length < 120) this.intervals.push(delta);
        const expected = this.expectedIntervalMs();
        if (expected > 0 && delta > expected * 2.5) {
          this.gaps += 1;
          this.maxGapMs = Math.max(this.maxGapMs, delta);
        }
      }
    } else {
      this.firstTs = tsMs;
    }
    this.lastTs = tsMs;
    this.composeTotal += composeMs;
    this.composeHist[Math.min(200, Math.max(0, Math.round(composeMs * 2)))] += 1;
    if (this.outFirstMs === null) this.outFirstMs = wallMs;
    this.outLastMs = wallMs;
    this.outFrames += 1;
  }

  drop() {
    this.dropped += 1;
  }

  private expectedIntervalMs(): number {
    if (this.intervals.length < 10) return 1000 / 30;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  summary(): RecordingStats {
    const span = this.firstTs !== null && this.lastTs !== null ? this.lastTs - this.firstTs : 0;
    const outSpan = this.outFirstMs !== null && this.outLastMs !== null ? this.outLastMs - this.outFirstMs : 0;
    let p95 = 0;
    const target = this.frames * 0.95;
    let seen = 0;
    for (let i = 0; i < this.composeHist.length; i += 1) {
      seen += this.composeHist[i];
      if (seen >= target) { p95 = i / 2; break; }
    }
    const round1 = (n: number) => Math.round(n * 10) / 10;
    return {
      mode: this.mode,
      frames: this.frames,
      cameraFps: span > 0 ? round1(((this.frames - 1) * 1000) / span) : 0,
      outputFps: outSpan > 0 ? round1(((this.outFrames - 1) * 1000) / outSpan) : 0,
      gaps: this.gaps,
      maxGapMs: Math.round(this.maxGapMs),
      dropped: this.dropped,
      avgComposeMs: this.frames ? round1(this.composeTotal / this.frames) : 0,
      p95ComposeMs: p95,
      durationMs: Math.round(span),
      width: this.width,
      height: this.height,
    };
  }
}

// One line per recording in the browser console / issue report.
export function describeRecordingStats(stats: RecordingStats): string {
  return `${stats.mode} ${stats.width}x${stats.height}: ${stats.frames} frames, camera ${stats.cameraFps} fps, ` +
    `out ${stats.outputFps} fps, ${stats.dropped} dropped, ${stats.gaps} camera gaps (max ${stats.maxGapMs} ms), ` +
    `compose avg ${stats.avgComposeMs} ms / p95 ${stats.p95ComposeMs} ms`;
}

// Recording is "laggy" when frames were lost or the camera stalled noticeably.
export function isLaggyRecording(stats: RecordingStats | null | undefined): boolean {
  if (!stats || stats.frames < 30) return false;
  const dropRate = stats.dropped / Math.max(1, stats.frames + stats.dropped);
  return dropRate > 0.02 || stats.maxGapMs > 500 || (stats.cameraFps > 0 && stats.cameraFps < 15);
}
