import { ConfigService } from '@nestjs/config';
import { DeviceHealthService } from './device-health.service.js';

function createService(): DeviceHealthService {
  return new DeviceHealthService(
    new ConfigService({
      TELEMETRY_OFFLINE_MULTIPLIER: '2',
      TELEMETRY_DEGRADED_TEMPERATURE_C: '70',
      TELEMETRY_DEGRADED_STORAGE_USED_PCT: '90',
    }),
  );
}

const BASE = {
  hasTelemetry: true,
  timestampSeconds: 100,
  expectedHeartbeatIntervalSeconds: 30,
  reportedStatus: 'online',
  temperatureC: null,
  storageUsedPct: null,
};

describe('DeviceHealthService recorder-observation semantics', () => {
  it('returns UNKNOWN when recorder evidence is stale', () => {
    const result = createService().evaluate({
      ...BASE,
      nowSeconds: 161,
      staleTelemetryIsUnknown: true,
    });

    expect(result.state).toBe('UNKNOWN');
    expect(result.reasons).toEqual(['STALE_OBSERVATION']);
    expect(result.ageSeconds).toBe(61);
    expect(result.offlineAfterSeconds).toBe(60);
  });

  it('preserves heartbeat-overdue OFFLINE for direct telemetry', () => {
    const result = createService().evaluate({
      ...BASE,
      nowSeconds: 161,
    });

    expect(result.state).toBe('OFFLINE');
    expect(result.reasons).toEqual(['HEARTBEAT_OVERDUE']);
  });

  it('accepts fresh authoritative recorder OFFLINE evidence', () => {
    const result = createService().evaluate({
      ...BASE,
      reportedStatus: 'offline',
      reportedOfflineIsAuthoritative: true,
      staleTelemetryIsUnknown: true,
      nowSeconds: 101,
    });

    expect(result.state).toBe('OFFLINE');
    expect(result.reasons).toEqual(['REPORTED_OFFLINE']);
  });
});
