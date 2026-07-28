import { ConfigService } from '@nestjs/config';
import {
  DeviceHealthService,
} from './device-health.service';

function createService(
  values: Record<string, string> = {},
): DeviceHealthService {
  const configService = {
    get: jest.fn(
      (key: string) => values[key],
    ),
  } as unknown as ConfigService;

  return new DeviceHealthService(
    configService,
  );
}

const baseInput = {
  hasTelemetry: true,
  timestampSeconds: 1_000,
  expectedHeartbeatIntervalSeconds:
    60,
  reportedStatus: 'online',
  temperatureC: 45,
  storageUsedPct: 50,
  nowSeconds: 1_050,
};

describe(
  'DeviceHealthService',
  () => {
    it(
      'returns NEVER_SEEN without telemetry',
      () => {
        const result =
          createService().evaluate({
            ...baseInput,
            hasTelemetry: false,
            timestampSeconds: null,
          });

        expect(result.state).toBe(
          'NEVER_SEEN',
        );

        expect(result.reasons).toEqual([
          'NO_TELEMETRY',
        ]);
      },
    );

    it(
      'returns UNKNOWN without a valid timestamp',
      () => {
        const result =
          createService().evaluate({
            ...baseInput,
            timestampSeconds: null,
          });

        expect(result.state).toBe(
          'UNKNOWN',
        );

        expect(result.reasons).toEqual([
          'INVALID_TIMESTAMP',
        ]);
      },
    );

    it(
      'returns ONLINE for current healthy telemetry',
      () => {
        const result =
          createService().evaluate(
            baseInput,
          );

        expect(result.state).toBe(
          'ONLINE',
        );

        expect(result.reasons).toEqual(
          [],
        );

        expect(
          result.ageSeconds,
        ).toBe(50);

        expect(
          result.offlineAfterSeconds,
        ).toBe(120);
      },
    );

    it(
      'returns OFFLINE after the heartbeat window',
      () => {
        const result =
          createService().evaluate({
            ...baseInput,
            nowSeconds: 1_121,
          });

        expect(result.state).toBe(
          'OFFLINE',
        );

        expect(result.reasons).toEqual([
          'HEARTBEAT_OVERDUE',
        ]);
      },
    );

    it(
      'keeps the exact offline boundary online',
      () => {
        const result =
          createService().evaluate({
            ...baseInput,
            nowSeconds: 1_120,
          });

        expect(result.state).toBe(
          'ONLINE',
        );
      },
    );

    it.each([
      'offline',
      'warning',
      'maintenance',
      'error',
    ])(
      'returns DEGRADED for reported status %s',
      (reportedStatus) => {
        const result =
          createService().evaluate({
            ...baseInput,
            reportedStatus,
          });

        expect(result.state).toBe(
          'DEGRADED',
        );

        expect(result.reasons).toContain(
          'REPORTED_STATUS_NOT_HEALTHY',
        );
      },
    );

    it(
      'returns DEGRADED for high temperature',
      () => {
        const result =
          createService().evaluate({
            ...baseInput,
            temperatureC: 70,
          });

        expect(result.state).toBe(
          'DEGRADED',
        );

        expect(result.reasons).toContain(
          'HIGH_TEMPERATURE',
        );
      },
    );

    it(
      'returns DEGRADED for high storage usage',
      () => {
        const result =
          createService().evaluate({
            ...baseInput,
            storageUsedPct: 90,
          });

        expect(result.state).toBe(
          'DEGRADED',
        );

        expect(result.reasons).toContain(
          'HIGH_STORAGE_USAGE',
        );
      },
    );

    it(
      'returns every simultaneous degradation reason',
      () => {
        const result =
          createService().evaluate({
            ...baseInput,
            reportedStatus: 'warning',
            temperatureC: 82,
            storageUsedPct: 97,
          });

        expect(result.state).toBe(
          'DEGRADED',
        );

        expect(result.reasons).toEqual([
          'REPORTED_STATUS_NOT_HEALTHY',
          'HIGH_TEMPERATURE',
          'HIGH_STORAGE_USAGE',
        ]);
      },
    );

    it(
      'uses configured thresholds',
      () => {
        const service =
          createService({
            TELEMETRY_OFFLINE_MULTIPLIER:
              '3',
            TELEMETRY_DEGRADED_TEMPERATURE_C:
              '80',
            TELEMETRY_DEGRADED_STORAGE_USED_PCT:
              '95',
          });

        const healthy =
          service.evaluate({
            ...baseInput,
            temperatureC: 79,
            storageUsedPct: 94,
            nowSeconds: 1_179,
          });

        expect(healthy.state).toBe(
          'ONLINE',
        );

        expect(
          healthy.offlineAfterSeconds,
        ).toBe(180);

        const degraded =
          service.evaluate({
            ...baseInput,
            temperatureC: 80,
            storageUsedPct: 95,
          });

        expect(degraded.state).toBe(
          'DEGRADED',
        );
      },
    );
  },
);
