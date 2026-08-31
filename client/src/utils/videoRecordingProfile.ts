/**
 * Packing-station recording profile.
 * Target: 2K MP4 recording.
 */

export const VIDEO_SIZE_WARN_MB = 100;
export const VIDEO_SIZE_HIGH_MB = 200;

export const CAMERA_CONSTRAINT_PROFILES = [
  {
    label: '1440p',
    video: {
      width: { ideal: 2560, max: 2560 },
      height: { ideal: 1440, max: 1440 },
      frameRate: { ideal: 30, max: 30 },
    },
  },
  {
    label: '1080p',
    video: {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 30 },
    },
  },
  {
    label: '720p',
    video: {
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
  },
  {
    label: 'default',
    video: true,
  },
];

export function pickRecordingBitrate(width = 2560, height = 1440) {
  const pixels = Number(width) * Number(height);
  if (pixels >= 2560 * 1440) return 4_000_000; // 2K target (~30 MB/min)
  if (pixels >= 1920 * 1080) return 2_500_000; // 1080p target
  return 1_150_000;
}

export function formatMb(bytes: number) {
  return `${((Number(bytes) || 0) / (1024 * 1024)).toFixed(1)} MB`;
}
