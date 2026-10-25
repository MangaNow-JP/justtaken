export const legacyCapturePolicy = Object.freeze({
  version: 'capture-v1',
  photoMaxBytes: 1_048_576,
  photoMaxEdge: 2048,
  videoMaxBytes: 12_582_912,
  videoMaxLongEdge: 1280,
  videoMaxShortEdge: 720,
  videoMaxFps: 30,
});
export const originalCapturePolicy = Object.freeze({
  version: 'capture-v2',
  photoMaxBytes: 67_108_864,
  photoMaxEdge: 16384,
  photoMaxPixels: 200_000_000,
  thumbnailMaxBytes: 65_536,
  thumbnailMaxEdge: 480,
  videoMaxBytes: 536_870_912,
  videoMaxDurationMs: 60_000,
  videoMaxLongEdge: 4096,
  videoMaxShortEdge: 2160,
  videoMaxFps: 60,
  uploadPartBytes: 8_388_608,
  commitWindowMs: 300_000,
  uploadWindowMs: 86_400_000,
  grantTtlSeconds: 120,
  captionMaxGraphemes: 500,
  commentMaxGraphemes: 300,
  quotaBytes: 2_147_483_648,
});

export const capturePolicy = Object.freeze({
  ...originalCapturePolicy,
  version: 'capture-v3',
  photoMaxBytes: 134_217_728,
  rawMaxBytes: 536_870_912,
});
export function mediaExtension(mime: string) {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/heic':
      return 'heic';
    case 'image/x-adobe-dng':
      return 'dng';
    case 'video/mp4':
      return 'mp4';
    default:
      throw new Error('Unsupported media type');
  }
}
