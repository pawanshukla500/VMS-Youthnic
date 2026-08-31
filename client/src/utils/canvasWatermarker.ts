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
    await this.video.play();
    this.renderLoop();

    // @ts-ignore - captureStream is not perfectly typed in standard lib
    this.stream = this.canvas.captureStream(30);
    
    // Add audio track if available
    const audioTrack = this.originalStream.getAudioTracks()[0];
    if (audioTrack) {
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
    
    // Draw Watermark
    const text = `STATION: ${this.stationId} | TRACKING: ${this.trackingId || 'IDLE'} | PK: ${this.packerId} | ${new Date().toLocaleString()}`;
    
    this.ctx.font = 'bold 36px monospace';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';

    // Outline
    this.ctx.strokeStyle = 'black';
    this.ctx.lineWidth = 4;
    this.ctx.strokeText(text, 20, 20);

    // Fill
    this.ctx.fillStyle = 'yellow';
    this.ctx.fillText(text, 20, 20);

    this.animationFrameId = requestAnimationFrame(this.renderLoop);
  }

  public stop() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.video.pause();
    this.video.srcObject = null;
  }
}
