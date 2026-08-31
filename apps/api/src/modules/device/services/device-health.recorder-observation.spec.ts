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
  it('9. stale recorder observation -> link UNKNOWN', () => {
    const result = createService().evaluate({
      ...BASE,
      nowSeconds: 161,
      isRecorderObserved: true,
      staleTelemetryIsUnknown: true,
    });

    expect(result.connectivity.linkState).toBe('UNKNOWN');
    expect(result.connectivity.reasons.map((r) => r.code)).toEqual([
      'STALE_OBSERVATION',
    ]);
    expect(result.connectivity.ageSeconds).toBe(61);
    expect(result.connectivity.offlineAfterSeconds).toBe(60);
    expect(result.health.state).toBe('UNKNOWN');
  });

  it('preserves heartbeat-overdue OFFLINE for direct telemetry', () => {
    const result = createService().evaluate({
      ...BASE,
      nowSeconds: 161,
    });

    expect(result.connectivity.linkState).toBe('OFFLINE');
    expect(result.connectivity.reasons.map((r) => r.code)).toEqual([
      'HEARTBEAT_OVERDUE',
    ]);
  });

  it('10. fresh authoritative recorder OFFLINE -> immediate link OFFLINE, child health CRITICAL', () => {
    const result = createService().evaluate({
      ...BASE,
      reportedStatus: 'offline',
      reportedOfflineIsAuthoritative: true,
      isRecorderObserved: true,
      staleTelemetryIsUnknown: true,
      observerDeviceId: 'recorder-1',
      channelNumber: 1,
      nowSeconds: 101,
    });

    expect(result.connectivity.linkState).toBe('OFFLINE');
    expect(result.connectivity.state).toBe('OFFLINE');
    expect(result.connectivity.reasons.map((r) => r.code)).toEqual([
      'REPORTED_OFFLINE',
      'RECORDER_VERIFIED_OFFLINE',
    ]);
    expect(result.health.state).toBe('CRITICAL');
    // The persisted / legacy reason list never leaks the health code while
    // the link is OFFLINE.
    expect(result.connectivity.legacyReasons).toEqual([
      'REPORTED_OFFLINE',
      'RECORDER_VERIFIED_OFFLINE',
    ]);
  });

  it('does not add RECORDER_VERIFIED_OFFLINE for a direct device reporting offline', () => {
    const result = createService().evaluate({
      ...BASE,
      reportedStatus: 'offline',
      reportedOfflineIsAuthoritative: true,
      isRecorderObserved: false,
      nowSeconds: 101,
    });

    expect(result.connectivity.reasons.map((r) => r.code)).toEqual([
      'REPORTED_OFFLINE',
    ]);
  });
});
