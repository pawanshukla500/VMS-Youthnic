// Burns the station / tracking / time tag into the packing video.
//
// Why this is not a plain canvas + requestAnimationFrame loop any more: that
// loop redrew at the screen's refresh rate while the canvas was sampled at a
// fixed 30 fps, so camera frames were duplicated or skipped (~25% repeated
// frames in real recordings = visible stutter), and every busy moment on the
// page (React render, IndexedDB write, a hidden / minimised window) froze
// the video. Now, in order of preference:
//   1. 'worker'          MediaStreamTrackProcessor -> worker (OffscreenCanvas)
//                        -> MediaStreamTrackGenerator. Exactly one output
//                        frame per camera frame, written as it arrives; runs
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
// The worker path is given up only after this many failures in a row (one
// slow start or camera hiccup must not cost the rest of the shift).
const WORKER_FAILURES_BEFORE_FALLBACK = 2;
// Worker warm-up (module + font) may delay the first recording at most this.
const WARMUP_WAIT_MS = 1500;
// No camera frame for this long = the camera is gone even if its track
// still claims to be live: end the session so the page can say so.
const NO_FRAMES_LIMIT_MS = 6000;
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
  private workerFailures = 0;
  private legacy: WatermarkSession | null = null;
  private sessions = new Set<WatermarkSession>();
  private disposed = false;
  private warm: Promise<void> | null = null;
  // Called when a running recording's pipeline gives up (camera gone, GPU
  // reset). The recorder stops by itself; the page tells the packer.
  public onPipelineError: ((message: string) => void) | null = null;

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
    if (this.disposed) throw new Error('Recorder was shut down');
    let session: WatermarkSession;
    if (supportsWorkerCompositor() && this.workerFailures < WORKER_FAILURES_BEFORE_FALLBACK) {
      try {
        session = await this.startWorkerSession();
        this.workerFailures = 0;
        return this.track(session);
      } catch (err) {
        this.workerFailures += 1;
        console.warn(`[recording] worker compositor failed (${this.workerFailures}/${WORKER_FAILURES_BEFORE_FALLBACK}), using main-thread fallback for this parcel:`, err);
      }
    }
    session = await this.startMainThreadSession(supportsVideoFrameCallback() ? 'video-frame' : 'animation-frame');
    return this.track(session);
  }

  private track(session: WatermarkSession): WatermarkSession {
    this.sessions.add(session);
    const stop = session.stop;
    session.stop = () => stop().finally(() => this.sessions.delete(session));
    return session;
  }

  // Load + compile the worker while the station is idle, so the first scan
  // does not pay for it inside the first-frame timeout.
  public prewarm(): Promise<void> {
    if (!supportsWorkerCompositor() || this.disposed) return Promise.resolve();
    if (!this.warm) {
      try {
        const worker = this.ensureWorker();
        this.warm = new Promise<void>((resolve) => {
          const onPong = (event: MessageEvent) => {
            if (event.data?.type !== 'pong') return;
            worker.removeEventListener('message', onPong);
            resolve();
          };
          worker.addEventListener('message', onPong);
          worker.postMessage({ type: 'ping', fontUrl: interFontUrl });
          window.setTimeout(resolve, 5000);
        });
      } catch {
        this.warm = Promise.resolve();
      }
    }
    return this.warm;
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      const worker = new Worker(new URL('../workers/recordingCompositor.worker.ts', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (event: MessageEvent) => {
        const data = event.data || {};
        if (data.type === 'error' && data.fatal) {
          this.workerFailures += 1;
          console.warn('[recording] compositor stopped a recording:', data.message);
          this.onPipelineError?.(String(data.message || 'recording pipeline failed'));
        }
      });
      this.worker = worker;
    }
    return this.worker;
  }

  private waitForWorker(worker: Worker, id: string, type: string, timeoutMs: number): Promise<any> {
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
    // Normally finished long before the first scan (prewarm at camera ready).
    await Promise.race([this.prewarm(), new Promise((resolve) => window.setTimeout(resolve, WARMUP_WAIT_MS))]);
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
    let lastSignOfLife = Date.now();
    let stopping = false;
    let watchdog = 0;
    // Camera unplugged, or silent for NO_FRAMES_LIMIT_MS: end the output
    // track so the recorder stops by itself and the page tells the packer
    // (a frozen video that keeps "recording" is the worst outcome).
    const endSession = (reason: string) => {
      if (stopping) return;
      stopping = true;
      window.clearInterval(watchdog);
      console.warn('[recording] ending session:', reason);
      this.onPipelineError?.(reason);
      worker.postMessage({ type: 'stop', id });
      source.stop();
      generator.stop();
    };
    const onStats = (event: MessageEvent) => {
      const data = event.data || {};
      if (data.id !== id) return;
      if (data.stats) lastStats = data.stats;
      if (data.type === 'stats' || data.type === 'first-frame') lastSignOfLife = Date.now();
      if (data.type === 'stopped' && !stopping) endSession('recording pipeline ended');
    };
    worker.addEventListener('message', onStats);
    const onSourceEnded = () => endSession('camera disconnected');
    source.addEventListener('ended', onSourceEnded);
    const firstFrame = this.waitForWorker(worker, id, 'first-frame', FIRST_FRAME_TIMEOUT_MS);
    try {
      worker.postMessage(
        { type: 'start', id, readable: processor.readable, writable: (generator as any).writable, width, height, meta: this.meta, fontUrl: interFontUrl },
        [processor.readable, (generator as any).writable]
      );
      await firstFrame;
    } catch (err) {
      stopping = true;
      worker.removeEventListener('message', onStats);
      source.removeEventListener('ended', onSourceEnded);
      worker.postMessage({ type: 'stop', id });
      source.stop();
      generator.stop();
      throw err;
    }
    watchdog = window.setInterval(() => {
      if (Date.now() - lastSignOfLife > NO_FRAMES_LIMIT_MS) {
        endSession(`camera sent no frames for ${Math.round(NO_FRAMES_LIMIT_MS / 1000)} s`);
      }
    }, 1000);

    let stopped: Promise<RecordingStats | null> | null = null;
    return {
      stream: new MediaStream([generator]),
      mode: 'worker',
      width,
      height,
      stop: () => {
        if (!stopped) {
          stopped = (async () => {
            const alreadyEnded = stopping;
            stopping = true;
            window.clearInterval(watchdog);
            source.removeEventListener('ended', onSourceEnded);
            const done = alreadyEnded ? Promise.resolve(null) : this.waitForWorker(worker, id, 'stopped', 1500).catch(() => null);
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
    let lastFrameAt = Date.now();
    let watchdog = 0;
    const endOutput = (reason: string) => {
      if (!active) return;
      active = false;
      window.clearInterval(watchdog);
      console.warn('[recording] ending session:', reason);
      this.onPipelineError?.(reason);
      output.getTracks().forEach((t) => t.stop());
    };
    const onCameraEnded = () => endOutput('camera disconnected');
    camera.addEventListener('ended', onCameraEnded);
    let resolveFirst: (() => void) | null = null;
    const firstFrame = new Promise<void>((resolve) => { resolveFirst = resolve; });

    const draw = (captureMs: number) => {
      const t0 = performance.now();
      ctx.drawImage(video, 0, 0, width, height);
      overlay.stamp(ctx, width, this.meta);
      track.requestFrame?.();
      lastFrameAt = Date.now();
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

    const gotFrame = await Promise.race([
      firstFrame.then(() => true),
      new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), FIRST_FRAME_TIMEOUT_MS)),
    ]);
    if (!gotFrame) {
      // No camera frames: fail the scan loudly instead of recording black.
      active = false;
      camera.removeEventListener('ended', onCameraEnded);
      if (mode === 'video-frame') (video as any).cancelVideoFrameCallback?.(handle);
      else cancelAnimationFrame(handle);
      output.getTracks().forEach((t) => t.stop());
      video.pause();
      video.srcObject = null;
      throw new Error('The camera is not delivering frames');
    }

    watchdog = window.setInterval(() => {
      if (Date.now() - lastFrameAt > NO_FRAMES_LIMIT_MS) {
        endOutput(`camera sent no frames for ${Math.round(NO_FRAMES_LIMIT_MS / 1000)} s`);
      }
    }, 1000);

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
            window.clearInterval(watchdog);
            camera.removeEventListener('ended', onCameraEnded);
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

  // Stops every running session (frees the per-recording camera clones)
  // and ends the worker.
  public async dispose() {
    this.disposed = true;
    this.stop();
    await Promise.all([...this.sessions].map((session) => session.stop().catch(() => null)));
    this.worker?.terminate();
    this.worker = null;
  }
}
