export class CanvasWatermarker {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private video: HTMLVideoElement;
  private animationFrameId: number | null = null;
  private stream: MediaStream | null = null;
  private trackingId: string;

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

    // Add audio track if available (shared mic track — never stopped here).
    const audioTrack = this.originalStream.getAudioTracks()[0];
    if (audioTrack && !this.stream.getAudioTracks().includes(audioTrack)) {
      this.stream.addTrack(audioTrack);
    }

    return this.stream;
  }

  public updateTrackingId(newId: string) {
    this.trackingId = newId;
  }

  public updateOperatorContext(stationId: string, packerId: string) {
    this.stationId = stationId;
    this.packerId = packerId;
  }

  private renderLoop = () => {
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

    // Watermark pill: white text on a translucent dark background stays
    // readable on any footage (yellow-on-video failed on bright parcels).
    // Two short lines so long emails/tracking IDs are never cut off.
    const pad = Math.max(12, Math.round(this.canvas.width * 0.02));
    const fontSize = Math.max(18, Math.round(this.canvas.width / 44));
    const lineHeight = Math.round(fontSize * 1.45);
    this.ctx.font = `600 ${fontSize}px Inter, 'JetBrains Mono', monospace`;
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';

    const time = new Date().toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const lines = [
      `STATION  ${this.stationId}   •   TRACKING  ${this.trackingId || 'IDLE'}`,
      `${this.packerId}   •   ${time}`,
    ];
    const textWidth = Math.max(...lines.map((line) => this.ctx.measureText(line).width));
    const pillX = pad;
    const pillY = pad;
    const pillW = textWidth + pad * 1.2;
    const pillH = lineHeight * lines.length + pad * 0.9;
    const radius = Math.min(14, Math.round(fontSize * 0.45));

    this.ctx.fillStyle = 'rgba(8, 12, 24, 0.62)';
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
