// Shape of the Electron preload bridge (window.desktop).
// Web builds have no bridge — every desktop* helper must no-op there so the
// web app keeps working byte-for-byte identically.

export interface DesktopRecordingMeta {
  trackingId: string;
  stationId: string;
  packerId: string;
  organizationId?: string;
  orderId?: string | null;
  marketplace?: string | null;
  timestamp: number;
  duration: number;
  mimeType: string;
}

export interface DesktopDiskEntry {
  id: string;
  ext: string;
  size: number;
  mtimeMs: number;
  meta: DesktopRecordingMeta | null;
}

export interface DesktopApi {
  isDesktop: true;
  platform: string;
  getVersion(): Promise<string>;
  saveRecording(
    id: string,
    ext: string,
    data: ArrayBuffer,
    meta: DesktopRecordingMeta
  ): Promise<{ path: string; size: number }>;
  readRecording(id: string): Promise<{ id: string; ext: string; data: ArrayBuffer; meta: DesktopRecordingMeta | null }>;
  listRecordings(): Promise<DesktopDiskEntry[]>;
  deleteRecording(id: string): Promise<{ deleted: boolean }>;
  setUploadActive(active: boolean): void;
}

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}

export {};
