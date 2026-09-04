export class CanvasWatermarker {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private video: HTMLVideoElement;
  private animationFrameId: number | null = null;
  private stream: MediaStream | null = null;
  private trackingId: string;
  private stationName: string | null = null;

  constructor(
    private originalStream: MediaStream, 
    private stationId: string, 
    trackingId: string, 
    private packerId: string
  ) {
    this.trackingId = trackingId;
    this.canvas = document.createElement('canvas');
    const track = originalStream.getVideoTracks()[0];
    const settings = track.getSettings();
    this.canvas.width = settings.width || 1280;
    this.canvas.height = settings.height || 720;
    
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context not supported');
    this.ctx = context;

    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = this.originalStream;
  }

  public async start(): Promise<MediaStream> {
    // Match app typography on the burned-in tag: Inter for the label line,
    // JetBrains Mono for station/time (same pairing as the UI). Wait briefly
    // for the webfonts; canvas falls back to monospace if they never load.
    try {
      await Promise.race([
        Promise.all([
          document.fonts.load('600 20px Inter'),
          document.fonts.load('500 20px "JetBrains Mono"'),
        ]),
        new Promise((resolve) => window.setTimeout(resolve, 1500)),
      ]);
    } catch {
      // Font preload is best-effort only.
    }
    // stop() detaches the video source; restore it so every scan transition
    // records live frames. Without this, all recordings after the first
    // stop/start cycle capture a black canvas.
    if (this.video.srcObject !== this.originalStream) {
      this.video.srcObject = this.originalStream;
    }
    // Make start idempotent: never run two render loops or leak streams.
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.stream?.getVideoTracks().forEach((track) => track.stop());
    await this.video.play();
    this.renderLoop();

    // @ts-ignore - captureStream is not perfectly typed in standard lib
    this.stream = this.canvas.captureStream(30);

    // No audio by policy: recordings are video-only even if the camera
    // exposes a microphone track.
    this.stream.getAudioTracks().forEach((track) => track.stop());

    return this.stream;
  }

  public updateTrackingId(newId: string) {
    this.trackingId = newId;
  }

  public updateOperatorContext(stationId: string, packerId: string, stationName?: string | null) {
    this.stationId = stationId;
    this.packerId = packerId;
    if (stationName !== undefined) this.stationName = stationName;
  }

  public updateStationName(stationName: string | null) {
    this.stationName = stationName;
  }

  private renderLoop = () => {
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

    // Watermark pill: small white text on a translucent dark background stays
    // readable on any footage without covering the parcel. Compact two-line
    // layout so long emails/tracking IDs are never cut off.
    const pad = Math.max(8, Math.round(this.canvas.width * 0.012));
    const fontSize = Math.min(22, Math.max(13, Math.round(this.canvas.width / 80)));
    const lineHeight = Math.round(fontSize * 1.4);
    const lineFonts = [
      `600 ${fontSize}px Inter, sans-serif`,
      `500 ${fontSize}px "JetBrains Mono", monospace`,
    ];
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';

    const time = new Date().toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const lines = buildWatermarkLines({
      stationId: this.stationId,
      stationName: this.stationName,
      trackingId: this.trackingId,
      time,
    });
    const textWidth = Math.max(...lines.map((line, i) => {
      this.ctx.font = lineFonts[i];
      return this.ctx.measureText(line).width;
    }));
    const pillX = pad;
    const pillY = pad;
    const pillW = textWidth + pad * 1.1;
    const pillH = lineHeight * lines.length + pad * 0.8;
    const radius = Math.min(10, Math.round(fontSize * 0.45));

    this.ctx.fillStyle = 'rgba(8, 12, 24, 0.5)';
    this.ctx.beginPath();
    if (typeof this.ctx.roundRect === 'function') {
      this.ctx.roundRect(pillX, pillY, pillW, pillH, radius);
    } else {
      this.ctx.rect(pillX, pillY, pillW, pillH);
    }
    this.ctx.fill();

    this.ctx.fillStyle = '#ffffff';
    this.ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    this.ctx.shadowBlur = 4;
    lines.forEach((line, i) => {
      this.ctx.font = lineFonts[i];
      this.ctx.fillText(line, pillX + pad * 0.6, pillY + pad * 0.45 + i * lineHeight);
    });
    this.ctx.shadowBlur = 0;

    this.animationFrameId = requestAnimationFrame(this.renderLoop);
  }

  public stop() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    // Release our canvas-capture video tracks. The shared original audio
    // track is left running — the next recording reuses it.
    this.stream?.getVideoTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
  }
}

// Pure line builder (unit-tested). Line 2 shows the human packing-station
// name — never the operator email.
export function buildWatermarkLines(args: { stationId: string; stationName?: string | null; trackingId: string; time: string }): [string, string] {
  const station = args.stationName?.trim() || args.stationId;
  return [
    `STATION  ${args.stationId}   •   TRACKING  ${args.trackingId || 'IDLE'}`,
    `${station}   •   ${args.time}`,
  ];
}
