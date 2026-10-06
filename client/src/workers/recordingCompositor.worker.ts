// Recording compositor: camera VideoFrames -> watermarked VideoFrames, off
// the main thread. One output frame per camera frame, carrying the camera's
// own timestamp, so the encoder gets the true cadence (no duplicated or
// skipped frames) and nothing on the page — React renders, IndexedDB
// writes, a hidden or minimised window — can stall the video.
//
// Protocol (main -> worker):
//   { type: 'start', id, readable, writable, width, height, meta, fontUrl }
//   { type: 'meta', meta }   (tracking id / station changes)
//   { type: 'stop', id }
// Worker -> main: { type: 'started' | 'first-frame' | 'stats' | 'stopped' | 'error', id, ... }
import {
  buildWatermarkLines,
  drawWatermark,
  formatWatermarkTime,
  FrameStats,
  WatermarkFonts,
  WatermarkMeta,
} from '../utils/watermarkOverlay';

// Typed against the DOM lib like the upload worker: only what we use.
const scope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  fonts?: { add(face: FontFace): void };
};

interface Session {
  id: string;
  stats: FrameStats;
  stopping: boolean;
  reader: ReadableStreamDefaultReader<VideoFrame>;
  writer: WritableStreamDefaultWriter<VideoFrame>;
}

let meta: WatermarkMeta = { stationId: 'UNKNOWN', stationName: null, trackingId: 'IDLE' };
let fonts: WatermarkFonts = { label: 'sans-serif', mono: 'monospace' };
let fontLoad: Promise<void> | null = null;
let session: Session | null = null;
const MAX_INFLIGHT_WRITES = 3;

// Overlay is re-rendered only when its text changes (about once a second).
let overlay: OffscreenCanvas | null = null;
let overlayKey = '';
let overlaySize = { width: 0, height: 0 };

function loadFont(url: string | undefined) {
  if (fontLoad || !url || typeof FontFace === 'undefined' || !scope.fonts) return;
  fontLoad = (async () => {
    try {
      const face = new FontFace('VmsInter', `url(${url})`, { weight: '400 700' });
      await face.load();
      scope.fonts!.add(face);
      fonts = { label: 'VmsInter, sans-serif', mono: 'VmsInter, monospace' };
      overlayKey = '';
    } catch {
      // System fonts are fine for the burned-in tag.
    }
  })();
}

function overlayFor(width: number): OffscreenCanvas {
  const lines = buildWatermarkLines({
    stationId: meta.stationId,
    stationName: meta.stationName,
    trackingId: meta.trackingId,
    time: formatWatermarkTime(new Date()),
  });
  const key = `${width}|${fonts.label}|${lines[0]}|${lines[1]}`;
  if (overlay && key === overlayKey) return overlay;
  // Size generously once, then draw into it (shadow needs a little margin).
  if (!overlay || overlay.width !== width) {
    overlay = new OffscreenCanvas(width, Math.max(64, Math.round(width / 12)));
  }
  const ctx = overlay.getContext('2d')!;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  overlaySize = drawWatermark(ctx, width, lines, fonts);
  overlayKey = key;
  return overlay;
}

async function run(s: Session, width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) as OffscreenCanvasRenderingContext2D;
  let sentFirst = false;
  let lastStatsPost = 0;
  let inflight = 0;
  try {
    while (!s.stopping) {
      const { value: frame, done } = await s.reader.read();
      if (done || !frame) break;
      const t0 = performance.now();
      let out: VideoFrame | null = null;
      try {
        ctx.drawImage(frame, 0, 0, width, height);
        const ov = overlayFor(width);
        ctx.drawImage(ov, 0, 0, overlaySize.width, overlaySize.height, 0, 0, overlaySize.width, overlaySize.height);
        out = new VideoFrame(canvas, {
          timestamp: frame.timestamp,
          ...(frame.duration ? { duration: frame.duration } : {}),
        });
      } catch {
        s.stats.drop();
      } finally {
        frame.close();
      }
      if (!out) continue;
      const composeMs = performance.now() - t0;
      // Encoder side slower than the camera: never queue unbounded frames
      // (a write normally settles within the same frame interval).
      if (inflight >= MAX_INFLIGHT_WRITES) {
        out.close();
        s.stats.drop();
        continue;
      }
      inflight += 1;
      s.writer.write(out).catch(() => undefined).finally(() => { inflight -= 1; });
      s.stats.frame(out.timestamp / 1000, composeMs, performance.now());
      if (!sentFirst) {
        sentFirst = true;
        scope.postMessage({ type: 'first-frame', id: s.id });
      }
      const now = performance.now();
      if (now - lastStatsPost > 5000) {
        lastStatsPost = now;
        scope.postMessage({ type: 'stats', id: s.id, stats: s.stats.summary() });
      }
    }
  } catch (err) {
    scope.postMessage({ type: 'error', id: s.id, message: err instanceof Error ? err.message : String(err) });
  } finally {
    try { await s.reader.cancel(); } catch { /* already closed */ }
    try { await s.writer.close(); } catch { /* track already stopped */ }
    scope.postMessage({ type: 'stopped', id: s.id, stats: s.stats.summary() });
    if (session === s) session = null;
  }
}

scope.onmessage = (event: MessageEvent) => {
  const msg = event.data || {};
  if (msg.type === 'meta' && msg.meta) {
    meta = { ...meta, ...msg.meta };
    return;
  }
  if (msg.type === 'start') {
    if (msg.meta) meta = { ...meta, ...msg.meta };
    loadFont(msg.fontUrl);
    if (session) session.stopping = true;
    const s: Session = {
      id: msg.id,
      stats: new FrameStats('worker', msg.width, msg.height),
      stopping: false,
      reader: (msg.readable as ReadableStream<VideoFrame>).getReader(),
      writer: (msg.writable as WritableStream<VideoFrame>).getWriter(),
    };
    session = s;
    scope.postMessage({ type: 'started', id: s.id });
    void run(s, msg.width, msg.height);
    return;
  }
  if (msg.type === 'stop' && session && session.id === msg.id) {
    session.stopping = true;
    // Unblock a pending read so the loop can finish.
    session.reader.cancel().catch(() => undefined);
  }
};
