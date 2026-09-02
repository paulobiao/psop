import { ConfigService } from '@nestjs/config';
import { DeviceHealthService } from './device-health.service';
import type { ReasonCode } from '../domain/operational-health.types';

function createService(
  values: Record<string, string> = {},
): DeviceHealthService {
  const configService = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;

  return new DeviceHealthService(configService);
}

const baseInput = {
  hasTelemetry: true,
  timestampSeconds: 1_000,
  expectedHeartbeatIntervalSeconds: 60,
  reportedStatus: 'online',
  temperatureC: 45,
  storageUsedPct: 50,
  nowSeconds: 1_050,
};

function codes(reasons: { code: ReasonCode }[]): ReasonCode[] {
  return reasons.map((reason) => reason.code);
}

describe('DeviceHealthService — three independent dimensions', () => {
  it('1. healthy direct device: link ONLINE, health HEALTHY, collection NOT_APPLICABLE', () => {
    const result = createService().evaluate(baseInput);

    expect(result.connectivity.linkState).toBe('ONLINE');
    expect(result.connectivity.state).toBe('ONLINE');
    expect(result.health.state).toBe('HEALTHY');
    expect(result.health.reasons).toEqual([]);
    expect(result.collection.state).toBe('NOT_APPLICABLE');
    expect(result.connectivity.ageSeconds).toBe(50);
    expect(result.connectivity.offlineAfterSeconds).toBe(120);
  });

  it('returns NEVER_SEEN without telemetry', () => {
    const result = createService().evaluate({
      ...baseInput,
      hasTelemetry: false,
      timestampSeconds: null,
    });

    expect(result.connectivity.linkState).toBe('NEVER_SEEN');
    expect(codes(result.connectivity.reasons)).toEqual(['NO_TELEMETRY']);
    expect(result.health.state).toBe('UNKNOWN');
  });

  it('returns UNKNOWN link without a valid timestamp', () => {
    const result = createService().evaluate({
      ...baseInput,
      timestampSeconds: null,
    });

    expect(result.connectivity.linkState).toBe('UNKNOWN');
    expect(codes(result.connectivity.reasons)).toEqual([
      'INVALID_TIMESTAMP',
    ]);
  });

  it('2. heartbeat overdue: link OFFLINE', () => {
    const result = createService().evaluate({
      ...baseInput,
      nowSeconds: 1_121,
    });

    expect(result.connectivity.linkState).toBe('OFFLINE');
    expect(result.connectivity.state).toBe('OFFLINE');
    expect(codes(result.connectivity.reasons)).toEqual([
      'HEARTBEAT_OVERDUE',
    ]);
    expect(result.health.state).toBe('UNKNOWN');
  });

  it('keeps the exact offline boundary online', () => {
    const result = createService().evaluate({
      ...baseInput,
      nowSeconds: 1_120,
    });

    expect(result.connectivity.linkState).toBe('ONLINE');
  });

  it('5. high storage usage: health DEGRADED, link ONLINE, compat state DEGRADED', () => {
    const result = createService().evaluate({
      ...baseInput,
      storageUsedPct: 90,
    });

    expect(result.connectivity.linkState).toBe('ONLINE');
    expect(result.connectivity.state).toBe('DEGRADED');
    expect(result.health.state).toBe('DEGRADED');
    expect(codes(result.health.reasons)).toContain('HIGH_STORAGE_USAGE');
  });

  it('6. high temperature: health DEGRADED, link ONLINE', () => {
    const result = createService().evaluate({
      ...baseInput,
      temperatureC: 70,
    });

    expect(result.connectivity.linkState).toBe('ONLINE');
    expect(result.health.state).toBe('DEGRADED');
    expect(codes(result.health.reasons)).toContain('HIGH_TEMPERATURE');
  });

  it.each(['offline', 'warning', 'maintenance', 'error'])(
    'maps reported status %s to a DEVICE_REPORTED_WARNING health reason (link stays ONLINE)',
    (reportedStatus) => {
      const result = createService().evaluate({
        ...baseInput,
        reportedStatus,
      });

      expect(result.connectivity.linkState).toBe('ONLINE');
      expect(result.health.state).toBe('DEGRADED');
      expect(codes(result.health.reasons)).toContain(
        'DEVICE_REPORTED_WARNING',
      );
    },
  );

  it.each(['unknown', 'unexpected-vendor-state'])(
    'unrecognised reported status %s -> health UNKNOWN, link ONLINE',
    (reportedStatus) => {
      const result = createService().evaluate({
        ...baseInput,
        reportedStatus,
      });

      expect(result.connectivity.linkState).toBe('ONLINE');
      expect(result.connectivity.state).toBe('UNKNOWN');
      expect(result.health.state).toBe('UNKNOWN');
      expect(codes(result.health.reasons)).toEqual([
        'UNRECOGNIZED_REPORTED_STATUS',
      ]);
    },
  );

  it('returns every simultaneous degradation reason', () => {
    const result = createService().evaluate({
      ...baseInput,
      reportedStatus: 'warning',
      temperatureC: 82,
      storageUsedPct: 97,
    });

    expect(result.health.state).toBe('DEGRADED');
    expect(codes(result.health.reasons)).toEqual([
      'DEVICE_REPORTED_WARNING',
      'HIGH_TEMPERATURE',
      'HIGH_STORAGE_USAGE',
    ]);
    // Legacy flat projection the frozen dashboard / persisted context see.
    expect(result.connectivity.legacyReasons).toEqual([
      'DEVICE_REPORTED_WARNING',
      'HIGH_TEMPERATURE',
      'HIGH_STORAGE_USAGE',
    ]);
  });

  it('7. optional firmware enrichment failure: collection PARTIAL, health HEALTHY, link ONLINE', () => {
    const result = createService().evaluate({
      ...baseInput,
      collectionState: 'PARTIAL',
      collectionIssues: [
        { code: 'OPTIONAL_ENRICHMENT_UNAVAILABLE', source: 'ADAPTER' },
      ],
    });

    expect(result.connectivity.linkState).toBe('ONLINE');
    expect(result.connectivity.state).toBe('ONLINE');
    expect(result.health.state).toBe('HEALTHY');
    expect(result.collection.state).toBe('PARTIAL');
    expect(codes(result.collection.issues)).toEqual([
      'OPTIONAL_ENRICHMENT_UNAVAILABLE',
    ]);
  });

  it('8. core telemetry source failure: collection PARTIAL, link/health unchanged', () => {
    const result = createService().evaluate({
      ...baseInput,
      collectionState: 'PARTIAL',
      collectionIssues: [
        { code: 'COLLECTION_SOURCE_FAILED', source: 'ADAPTER' },
      ],
    });

    expect(result.connectivity.linkState).toBe('ONLINE');
    expect(result.connectivity.state).toBe('ONLINE');
    expect(result.health.state).toBe('HEALTHY');
    expect(result.collection.state).toBe('PARTIAL');
  });

  it('7b. a reported COMPLETE with an OPTIONAL_ENRICHMENT_UNAVAILABLE issue is reconciled to PARTIAL', () => {
    const result = createService().evaluate({
      ...baseInput,
      collectionState: 'COMPLETE',
      collectionIssues: [
        { code: 'OPTIONAL_ENRICHMENT_UNAVAILABLE', source: 'ADAPTER' },
        { code: 'OPTIONAL_ENRICHMENT_UNAVAILABLE', source: 'ADAPTER' },
      ],
    });

    // The optional gap only downgrades collection quality — never a core failure.
    expect(result.collection.state).toBe('PARTIAL');
    expect(codes(result.collection.issues)).toEqual([
      'OPTIONAL_ENRICHMENT_UNAVAILABLE',
      'OPTIONAL_ENRICHMENT_UNAVAILABLE',
    ]);
    // Connectivity / health are untouched.
    expect(result.connectivity.linkState).toBe('ONLINE');
    expect(result.connectivity.state).toBe('ONLINE');
    expect(result.health.state).toBe('HEALTHY');
    expect(result.health.reasons).toEqual([]);
  });

  it('7c. a reported COMPLETE with no issues stays COMPLETE', () => {
    const result = createService().evaluate({
      ...baseInput,
      collectionState: 'COMPLETE',
      collectionIssues: [],
    });

    expect(result.collection.state).toBe('COMPLETE');
    expect(result.collection.issues).toEqual([]);
  });

  it('4/14. storageState NOT_INSTALLED: recorder HEALTHY, no storage/recording health reason', () => {
    const result = createService().evaluate({
      ...baseInput,
      storageUsedPct: null,
      capabilities: {
        storage: { supported: true, present: false, state: 'NOT_INSTALLED' },
        recording: { state: 'NOT_AVAILABLE_NO_STORAGE' },
      },
    });

    expect(result.connectivity.linkState).toBe('ONLINE');
    expect(result.health.state).toBe('HEALTHY');
    expect(result.health.reasons).toEqual([]);
    expect(result.capabilities.storage.state).toBe('NOT_INSTALLED');
    expect(result.capabilities.recording.state).toBe(
      'NOT_AVAILABLE_NO_STORAGE',
    );
  });

  it('recording ABNORMAL only degrades health when storage is physically present', () => {
    const withoutStorage = createService().evaluate({
      ...baseInput,
      capabilities: {
        storage: { supported: true, present: false, state: 'NOT_INSTALLED' },
        recording: { state: 'ABNORMAL' },
      },
    });
    expect(withoutStorage.health.state).toBe('HEALTHY');

    const withStorage = createService().evaluate({
      ...baseInput,
      capabilities: {
        storage: { supported: true, present: true, state: 'PRESENT' },
        recording: { state: 'ABNORMAL' },
      },
    });
    expect(withStorage.health.state).toBe('DEGRADED');
    expect(codes(withStorage.health.reasons)).toContain('RECORDING_ABNORMAL');
  });

  it('uses configured thresholds', () => {
    const service = createService({
      TELEMETRY_OFFLINE_MULTIPLIER: '3',
      TELEMETRY_DEGRADED_TEMPERATURE_C: '80',
      TELEMETRY_DEGRADED_STORAGE_USED_PCT: '95',
    });

    const healthy = service.evaluate({
      ...baseInput,
      temperatureC: 79,
      storageUsedPct: 94,
      nowSeconds: 1_179,
    });

    expect(healthy.health.state).toBe('HEALTHY');
    expect(healthy.connectivity.offlineAfterSeconds).toBe(180);

    const degraded = service.evaluate({
      ...baseInput,
      temperatureC: 80,
      storageUsedPct: 95,
    });

    expect(degraded.health.state).toBe('DEGRADED');
  });
});
