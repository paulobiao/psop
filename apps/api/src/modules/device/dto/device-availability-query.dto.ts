import { IsIn, IsISO8601, IsOptional } from 'class-validator';

export const AVAILABILITY_WINDOW_PRESETS = [
  '24h',
  '7d',
  '30d',
] as const;

export type AvailabilityWindowPreset =
  (typeof AVAILABILITY_WINDOW_PRESETS)[number];

/**
 * Query for `GET /devices/:id/availability`.
 *
 * Resolution order (see `DeviceAvailabilityService.resolvePeriod`):
 *  1. explicit `from` (+ optional `to`, default = now) wins;
 *  2. otherwise `window` preset (relative to now);
 *  3. otherwise the default 24h window.
 *
 * `to` is always clamped to "now" for the math — the future is never uptime.
 */
export class DeviceAvailabilityQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsIn(AVAILABILITY_WINDOW_PRESETS)
  window?: AvailabilityWindowPreset;
}
