import { z } from 'zod';

// Integer units keep Swift/Kotlin/JS canonical signatures identical. Location is
// device-reported evidence, not a trusted assertion about where a scene occurred.
export const captureLocationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('off') }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
  z
    .object({
      status: z.literal('recorded'),
      source: z.literal('device-location'),
      latitudeE7: z.number().int().min(-900_000_000).max(900_000_000),
      longitudeE7: z.number().int().min(-1_800_000_000).max(1_800_000_000),
      horizontalAccuracyMm: z.number().int().min(0).max(100_000_000),
      measuredAt: z.iso.datetime(),
      accuracyAuthorization: z.enum(['precise', 'approximate']),
    })
    .strict(),
]);
export type CaptureLocation = z.infer<typeof captureLocationSchema>;

export function locationSummary(location?: CaptureLocation): string {
  if (!location) return '位置情報の記録なし';
  if (location.status === 'off') return 'GPS：オフ（位置情報なし）';
  if (location.status === 'unavailable') return 'GPS：取得できず（位置情報なし）';
  const accuracy = Math.ceil(location.horizontalAccuracyMm / 1000);
  return `${(location.latitudeE7 / 1e7).toFixed(6)}, ${(location.longitudeE7 / 1e7).toFixed(6)} · 精度の目安 ${accuracy}m${location.accuracyAuthorization === 'approximate' ? '（おおよその位置）' : ''}`;
}
