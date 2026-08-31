export interface HealthCheckResult {
  camera: boolean;
  mp4: boolean;
  storage: boolean;
  ready: boolean;
}

export const MP4_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4'
];

export function getSupportedMp4MimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return MP4_MIME_CANDIDATES.find(type => MediaRecorder.isTypeSupported(type)) || null;
}

export async function runHealthCheck(): Promise<HealthCheckResult> {
  // 1. Camera check
  const camera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  
  // 2. MP4 check
  const mp4 = getSupportedMp4MimeType() !== null;
  
  // 3. Storage check
  let storage = false;
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      // Require at least some storage to be available/detectable
      if (estimate.quota !== undefined) {
        storage = true;
      }
    } catch (e) {
      storage = false;
    }
  }

  // 4. We will check Firebase connection in Phase 6, currently assume true
  const firebaseReady = true;

  const ready = camera && mp4 && storage && firebaseReady;

  return { camera, mp4, storage, ready };
}
