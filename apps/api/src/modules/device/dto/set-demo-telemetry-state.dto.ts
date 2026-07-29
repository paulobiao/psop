import { IsIn } from 'class-validator';

export const TELEMETRY_DEMO_STATES = [
  'ONLINE',
  'DEGRADED',
  'OFFLINE',
  'NEVER_SEEN',
  'UNKNOWN',
] as const;

export type TelemetryDemoState =
  (typeof TELEMETRY_DEMO_STATES)[number];

export class SetDemoTelemetryStateDto {
  @IsIn(TELEMETRY_DEMO_STATES)
  state!: TelemetryDemoState;
}
