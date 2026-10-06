// Burns the station / tracking / time tag into the packing video.
//
// Why this is not a plain canvas + requestAnimationFrame loop any more: that
// loop redrew at the screen's refresh rate while the canvas was sampled at a
// fixed 30 fps, so camera frames were duplicated or skipped (~25% repeated
// frames in real recordings = visible stutter), and every busy moment on the
// page (React render, IndexedDB write, a hidden / minimised window) froze
// the video. Now, in order of preference:
//   1. 'worker'          MediaStreamTrackProcessor -> worker (OffscreenCanvas)
//                        -> MediaStreamTrackGenerator. One output frame per
//                        camera frame with the camera's own timestamp; runs
//                        off the main thread and is never throttled.
//   2. 'video-frame'     main thread, drawn once per camera frame
//                        (requestVideoFrameCallback) + captureStream(0).
//   3. 'animation-frame' the old loop, for browsers with neither.
// Each recording gets its own session (startSession -> stop), so the next
// parcel can start while the previous video is still being saved.
import interFontUrl from '../assets/fonts/inter.woff2?url';
import {
  buildWatermarkLines,
  CompositorMode,
  describeRecordingStats,
  drawWatermark,
  formatWatermarkTime,
  FrameStats,
  RecordingStats,
  WatermarkFonts,
  WatermarkMeta,
} from './watermarkOverlay';

export { buildWatermarkLines } from './watermarkOverlay';
export type { CompositorMode, RecordingStats } from './watermarkOverlay';

export interface WatermarkSession {
  stream: MediaStream;
  mode: CompositorMode;
  width: number;
  height: number;
  // Stops this session's pipeline and returns its frame statistics.
  stop(): Promise<RecordingStats | null>;
}

const FIRST_FRAME_TIMEOUT_MS = 2500;
const MAIN_THREAD_FONTS: WatermarkFonts = { label: 'Inter, sans-serif', mono: '"JetBrains Mono", monospace' };

export function supportsWorkerCompositor(): boolean {
  const w = globalThis as any;
  return typeof w.MediaStreamTrackProcessor === 'function'
    && typeof w.MediaStreamTrackGenerator === 'function'
    && typeof w.VideoFrame === 'function'
    && typeof w.OffscreenCanvas === 'function'
    && typeof w.Worker === 'function';
}

export function supportsVideoFrameCallback(): boolean {
  return typeof HTMLVideoElement !== 'undefined'
    && typeof (HTMLVideoElement.prototype as any).requestVideoFrameCallback === 'function';
}

function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Main-thread overlay cache (fallback modes): redraw the tag only when its
// text changes, then stamp it onto every frame.
class OverlayCache {
  private canvas = document.createElement('canvas');
  private key = '';
  private size = { width: 0, height: 0 };

  stamp(ctx: CanvasRenderingContext2D, width: number, meta: WatermarkMeta) {
    const lines = buildWatermarkLines({ ...meta, time: formatWatermarkTime(new Date()) });
    const key = `${width}|${lines[0]}|${lines[1]}`;
    if (key !== this.key) {
      if (this.canvas.width !== width) {
        this.canvas.width = width;
        this.canvas.height = Math.max(64, Math.round(width / 12));
      }
      const octx = this.canvas.getContext('2d')!;
      octx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.size = drawWatermark(octx, width, lines, MAIN_THREAD_FONTS);
      this.key = key;
    }
    ctx.drawImage(this.canvas, 0, 0, this.size.width, this.size.height, 0, 0, this.size.width, this.size.height);
  }
}

export class CanvasWatermarker {
  private meta: WatermarkMeta;
  private worker: Worker | null = null;
  private workerFailed = false;
  private legacy: WatermarkSession | null = null;

  constructor(
    private originalStream: MediaStream,
    stationId: string,
    trackingId: string,
    // Kept for API compatibility; the operator is never burned in.
    _packerId: string
  ) {
    this.meta = { stationId, stationName: null, trackingId };
  }

  public updateTrackingId(newId: string) {
    this.meta = { ...this.meta, trackingId: newId };
    this.postMeta();
  }

  public updateOperatorContext(stationId: string, _packerId: string, stationName?: string | null) {
    this.meta = { ...this.meta, stationId, ...(stationName !== undefined ? { stationName } : {}) };
    this.postMeta();
  }

  public updateStationName(stationName: string | null) {
    this.meta = { ...this.meta, stationName };
    this.postMeta();
  }

  private postMeta() {
    this.worker?.postMessage({ type: 'meta', meta: this.meta });
  }

  private cameraTrack(): MediaStreamTrack {
    const track = this.originalStream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') throw new Error('Camera stream is not live');
    return track;
  }

  private dimensions(track: MediaStreamTrack) {
    const settings = track.getSettings();
    return { width: settings.width || 1280, height: settings.height || 720 };
  }

  public async startSession(): Promise<WatermarkSession> {
    if (supportsWorkerCompositor() && !this.workerFailed) {
      try {
        return await this.startWorkerSession();
      } catch (err) {
        // Remember for this station run; the fallback still records smoothly.
        this.workerFailed = true;
        console.warn('[recording] worker compositor unavailable, using main-thread fallback:', err);
      }
    }
    if (supportsVideoFrameCallback()) return this.startMainThreadSession('video-frame');
    return this.startMainThreadSession('animation-frame');
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/recordingCompositor.worker.ts', import.meta.url), { type: 'module' });
    }
    return this.worker;
  }

  private waitForWorker(id: string, type: string, timeoutMs: number): Promise<any> {
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        worker.removeEventListener('message', onMessage);
        reject(new Error(`compositor ${type} timeout`));
      }, timeoutMs);
      const onMessage = (event: MessageEvent) => {
        const data = event.data || {};
        if (data.id !== id) return;
        if (data.type === type || (data.type === 'error' && type !== 'stopped')) {
          window.clearTimeout(timer);
          worker.removeEventListener('message', onMessage);
          if (data.type === 'error') reject(new Error(data.message || 'compositor error'));
          else resolve(data);
        }
      };
      worker.addEventListener('message', onMessage);
    });
  }

  private async startWorkerSession(): Promise<WatermarkSession> {
    const camera = this.cameraTrack();
    const { width, height } = this.dimensions(camera);
    const w = globalThis as any;
    // A clone per recording: stopping it never touches the live preview.
    const source = camera.clone();
    const processor = new w.MediaStreamTrackProcessor({ track: source, maxBufferSize: 4 });
    const generator: MediaStreamTrack = new w.MediaStreamTrackGenerator({ kind: 'video' });
    const worker = this.ensureWorker();
    const id = newSessionId();
    let lastStats: RecordingStats | null = null;
    const onStats = (event: MessageEvent) => {
      if (event.data?.id === id && event.data?.stats) lastStats = event.data.stats;
    };
    worker.addEventListener('message', onStats);
    const firstFrame = this.waitForWorker(id, 'first-frame', FIRST_FRAME_TIMEOUT_MS);
    try {
      worker.postMessage(
        { type: 'start', id, readable: processor.readable, writable: (generator as any).writable, width, height, meta: this.meta, fontUrl: interFontUrl },
        [processor.readable, (generator as any).writable]
      );
      await firstFrame;
    } catch (err) {
      worker.removeEventListener('message', onStats);
      worker.postMessage({ type: 'stop', id });
      source.stop();
      generator.stop();
      throw err;
    }

    let stopped: Promise<RecordingStats | null> | null = null;
    return {
      stream: new MediaStream([generator]),
      mode: 'worker',
      width,
      height,
      stop: () => {
        if (!stopped) {
          stopped = (async () => {
            const done = this.waitForWorker(id, 'stopped', 1500).catch(() => null);
            worker.postMessage({ type: 'stop', id });
            source.stop();
            const final = await done;
            generator.stop();
            worker.removeEventListener('message', onStats);
            const stats: RecordingStats | null = final?.stats || lastStats;
            if (stats) console.info(`[recording] ${describeRecordingStats(stats)}`);
            return stats;
          })();
        }
        return stopped;
      },
    };
  }

  private async startMainThreadSession(mode: 'video-frame' | 'animation-frame'): Promise<WatermarkSession> {
    const camera = this.cameraTrack();
    const { width, height } = this.dimensions(camera);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([camera]);
    await video.play();

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) as CanvasRenderingContext2D;
    const overlay = new OverlayCache();
    const stats = new FrameStats(mode, width, height);
    // video-frame: one frame per camera frame (requestFrame); animation-frame:
    // the browser samples the canvas at up to 30 fps (legacy behaviour).
    const output = (canvas as any).captureStream(mode === 'video-frame' ? 0 : 30) as MediaStream;
    const track = output.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    let active = true;
    let handle = 0;
    let lastPresented = -1;
    let resolveFirst: (() => void) | null = null;
    const firstFrame = new Promise<void>((resolve) => { resolveFirst = resolve; });

    const draw = (captureMs: number) => {
      const t0 = performance.now();
      ctx.drawImage(video, 0, 0, width, height);
      overlay.stamp(ctx, width, this.meta);
      track.requestFrame?.();
      stats.frame(captureMs, performance.now() - t0, performance.now());
      resolveFirst?.();
      resolveFirst = null;
    };

    if (mode === 'video-frame') {
      const onFrame = (now: number, metadata: any) => {
        if (!active) return;
        const presented = Number(metadata?.presentedFrames);
        if (lastPresented >= 0 && Number.isFinite(presented) && presented - lastPresented > 1) {
          for (let i = 1; i < presented - lastPresented; i += 1) stats.drop();
        }
        if (Number.isFinite(presented)) lastPresented = presented;
        const capture = Number(metadata?.captureTime) || Number(metadata?.mediaTime) * 1000 || now;
        draw(capture);
        handle = (video as any).requestVideoFrameCallback(onFrame);
      };
      handle = (video as any).requestVideoFrameCallback(onFrame);
    } else {
      const loop = (now: number) => {
        if (!active) return;
        draw(now);
        handle = requestAnimationFrame(loop);
      };
      handle = requestAnimationFrame(loop);
    }

    await Promise.race([firstFrame, new Promise((resolve) => window.setTimeout(resolve, FIRST_FRAME_TIMEOUT_MS))]);

    let stopped: Promise<RecordingStats | null> | null = null;
    return {
      stream: output,
      mode,
      width,
      height,
      stop: () => {
        if (!stopped) {
          stopped = (async () => {
            active = false;
            if (mode === 'video-frame') (video as any).cancelVideoFrameCallback?.(handle);
            else cancelAnimationFrame(handle);
            output.getTracks().forEach((t) => t.stop());
            video.pause();
            video.srcObject = null;
            const summary = stats.summary();
            console.info(`[recording] ${describeRecordingStats(summary)}`);
            return summary;
          })();
        }
        return stopped;
      },
    };
  }

  // Legacy single-session API (kept for older call sites).
  public async start(): Promise<MediaStream> {
    await this.legacy?.stop();
    this.legacy = await this.startSession();
    return this.legacy.stream;
  }

  public stop() {
    void this.legacy?.stop();
    this.legacy = null;
  }

  public dispose() {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
  }
}
