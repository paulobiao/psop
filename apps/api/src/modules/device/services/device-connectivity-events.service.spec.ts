import { ConfigService } from '@nestjs/config';
import { DeviceConnectivityEventsService } from './device-connectivity-events.service.js';

function buildSnapshot(overrides: {
  id: string;
  name: string;
  state: 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'UNKNOWN';
  linkState?: 'ONLINE' | 'OFFLINE' | 'UNKNOWN' | 'NEVER_SEEN';
  healthState?: 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'UNKNOWN';
  healthReasons?: string[];
  collectionState?: 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'NOT_APPLICABLE';
  collectionIssues?: string[];
  reasons?: string[];
  observerDeviceId?: string | null;
  channelNumber?: number | null;
  monitoringSource?: string;
  individualVerification?: string;
}) {
  return {
    device: {
      id: overrides.id,
      name: overrides.name,
      siteId: 'site-1',
      siteCode: 'DFB-01',
      externalId: overrides.id,
    },
    monitoring: {
      source: overrides.monitoringSource ?? 'DIRECT',
      individualVerification:
        overrides.individualVerification ?? 'DIRECT',
      observerDeviceId: overrides.observerDeviceId ?? null,
    },
    connectivity: {
      state: overrides.state,
      linkState:
        overrides.linkState ??
        (overrides.state === 'DEGRADED' ? 'ONLINE' : overrides.state),
      reasons: overrides.reasons ?? [],
      lastHeartbeatAt: null,
      ageSeconds: 10,
    },
    health: {
      state:
        overrides.healthState ??
        (overrides.state === 'DEGRADED' ? 'DEGRADED' : 'HEALTHY'),
      reasons: (overrides.healthReasons ?? []).map((code) => ({
        code,
        source: 'DEVICE',
      })),
    },
    collection: {
      state: overrides.collectionState ?? 'NOT_APPLICABLE',
      issues: (overrides.collectionIssues ?? []).map((code) => ({
        code,
        source: 'ADAPTER',
      })),
    },
    telemetry: {
      channelId: null,
      channelNumber: overrides.channelNumber ?? null,
    },
  };
}

describe('DeviceConnectivityEventsService.evaluateFleet', () => {
  const telemetryService = { findFleet: jest.fn() };
  const alertService = {
    openConnectivityAlert: jest.fn(),
    resolveConnectivityAlert: jest.fn(),
    touchConnectivityAlert: jest.fn(),
  };
  const telemetryDemoService = { isEnabled: () => false };
  const localTelemetryService = {
    isEnabled: () => true,
    storeEvent: jest.fn(),
    findLatestEvent: jest.fn(),
  };
  const deviceRepository = {};

  function createService(
    config: Record<string, string> = {},
  ): DeviceConnectivityEventsService {
    return new DeviceConnectivityEventsService(
      new ConfigService(config),
      deviceRepository as any,
      telemetryService as any,
      alertService as any,
      telemetryDemoService as any,
      localTelemetryService as any,
    );
  }

  let service: DeviceConnectivityEventsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = createService();
    localTelemetryService.storeEvent.mockImplementation((event) =>
      Promise.resolve(event),
    );
  });

  it('opens a single incident and records an event on a fresh ONLINE -> OFFLINE transition', async () => {
    const snapshot = buildSnapshot({
      id: 'cam-1',
      name: 'Hikvision 01',
      state: 'OFFLINE',
      linkState: 'OFFLINE',
      healthState: 'CRITICAL',
      reasons: ['REPORTED_OFFLINE', 'RECORDER_VERIFIED_OFFLINE'],
      observerDeviceId: 'recorder-1',
      channelNumber: 1,
      monitoringSource: 'RECORDER_OBSERVED',
      individualVerification: 'RECORDER_VERIFIED',
    });

    telemetryService.findFleet.mockResolvedValue({ devices: [snapshot] });
    localTelemetryService.findLatestEvent.mockResolvedValue(undefined);

    const result = await service.evaluateFleet();

    expect(result.createdEvents).toBe(1);

    const storedEvent =
      localTelemetryService.storeEvent.mock.calls[0][0];
    expect(storedEvent.event_type).toBe('INITIAL_STATE');
    expect(storedEvent.context).toEqual(
      expect.objectContaining({
        reasons: ['REPORTED_OFFLINE', 'RECORDER_VERIFIED_OFFLINE'],
        observerDeviceId: 'recorder-1',
        channelNumber: 1,
        dimension: 'CONNECTIVITY',
        linkState: 'OFFLINE',
      }),
    );

    expect(alertService.openConnectivityAlert).toHaveBeenCalledTimes(1);
    expect(alertService.touchConnectivityAlert).not.toHaveBeenCalled();
  });

  it('resolves the observer device name for a recorder present in the same fleet evaluation', async () => {
    const recorder = buildSnapshot({
      id: 'recorder-1',
      name: 'NVR Speco',
      state: 'ONLINE',
    });
    const camera = buildSnapshot({
      id: 'cam-1',
      name: 'Hikvision 01',
      state: 'OFFLINE',
      linkState: 'OFFLINE',
      reasons: ['REPORTED_OFFLINE', 'RECORDER_VERIFIED_OFFLINE'],
      observerDeviceId: 'recorder-1',
      channelNumber: 1,
      monitoringSource: 'RECORDER_OBSERVED',
      individualVerification: 'RECORDER_VERIFIED',
    });

    telemetryService.findFleet.mockResolvedValue({
      devices: [recorder, camera],
    });
    localTelemetryService.findLatestEvent.mockResolvedValue(undefined);

    await service.evaluateFleet();

    expect(alertService.openConnectivityAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'cam-1',
        context: expect.objectContaining({
          observerDeviceId: 'recorder-1',
          observerDeviceName: 'NVR Speco',
        }),
      }),
    );
    expect(alertService.resolveConnectivityAlert).toHaveBeenCalledWith(
      'recorder-1',
      'ONLINE',
      expect.anything(),
    );
  });

  it('escalates severity by going through the full transition path on DEGRADED -> OFFLINE', async () => {
    const snapshot = buildSnapshot({
      id: 'cam-1',
      name: 'Hikvision 01',
      state: 'OFFLINE',
      linkState: 'OFFLINE',
      reasons: ['REPORTED_OFFLINE', 'RECORDER_VERIFIED_OFFLINE'],
      monitoringSource: 'RECORDER_OBSERVED',
    });

    telemetryService.findFleet.mockResolvedValue({ devices: [snapshot] });
    localTelemetryService.findLatestEvent.mockResolvedValue({
      current_state: 'DEGRADED',
    });

    const result = await service.evaluateFleet();

    expect(result.createdEvents).toBe(1);
    expect(alertService.openConnectivityAlert).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'OFFLINE' }),
    );
  });

  it('tags a health degradation incident with dimension HEALTH', async () => {
    const snapshot = buildSnapshot({
      id: 'cam-1',
      name: 'Hikvision 01',
      state: 'DEGRADED',
      linkState: 'ONLINE',
      healthState: 'DEGRADED',
      healthReasons: ['HIGH_TEMPERATURE'],
      reasons: ['HIGH_TEMPERATURE'],
    });

    telemetryService.findFleet.mockResolvedValue({ devices: [snapshot] });
    localTelemetryService.findLatestEvent.mockResolvedValue(undefined);

    await service.evaluateFleet();

    expect(alertService.openConnectivityAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'DEGRADED',
        context: expect.objectContaining({
          dimension: 'HEALTH',
          linkState: 'ONLINE',
          healthState: 'DEGRADED',
        }),
      }),
    );
  });

  it('11. repeated PARTIAL / COMPLETE<->PARTIAL collection changes produce no connectivity event or incident', async () => {
    const online = buildSnapshot({
      id: 'nvr-1',
      name: 'NVR Speco',
      state: 'ONLINE',
      linkState: 'ONLINE',
      healthState: 'HEALTHY',
      collectionState: 'PARTIAL',
      collectionIssues: ['OPTIONAL_ENRICHMENT_UNAVAILABLE'],
    });

    telemetryService.findFleet.mockResolvedValue({ devices: [online] });
    localTelemetryService.findLatestEvent.mockResolvedValue({
      current_state: 'ONLINE',
    });

    const first = await service.evaluateFleet();
    expect(first.createdEvents).toBe(0);

    // flip collection COMPLETE then back to PARTIAL — still no events
    online.collection.state = 'COMPLETE';
    online.collection.issues = [];
    const second = await service.evaluateFleet();
    expect(second.createdEvents).toBe(0);

    online.collection.state = 'PARTIAL';
    const third = await service.evaluateFleet();
    expect(third.createdEvents).toBe(0);

    expect(alertService.openConnectivityAlert).not.toHaveBeenCalled();
    expect(alertService.resolveConnectivityAlert).not.toHaveBeenCalled();
    expect(alertService.touchConnectivityAlert).not.toHaveBeenCalled();
  });

  it('does not create a new event or a new INCIDENT_OPENED when polling the same OFFLINE state twice', async () => {
    const snapshot = buildSnapshot({
      id: 'cam-1',
      name: 'Hikvision 01',
      state: 'OFFLINE',
      linkState: 'OFFLINE',
      reasons: ['REPORTED_OFFLINE', 'RECORDER_VERIFIED_OFFLINE'],
      observerDeviceId: 'recorder-1',
      channelNumber: 1,
    });

    telemetryService.findFleet.mockResolvedValue({ devices: [snapshot] });
    localTelemetryService.findLatestEvent.mockResolvedValue({
      current_state: 'OFFLINE',
    });

    const result = await service.evaluateFleet();

    expect(result.createdEvents).toBe(0);
    expect(localTelemetryService.storeEvent).not.toHaveBeenCalled();
    expect(alertService.openConnectivityAlert).not.toHaveBeenCalled();
    expect(alertService.touchConnectivityAlert).toHaveBeenCalledTimes(1);
  });

  it('resolves the incident exactly once on OFFLINE -> ONLINE', async () => {
    const snapshot = buildSnapshot({
      id: 'cam-1',
      name: 'Hikvision 01',
      state: 'ONLINE',
    });

    telemetryService.findFleet.mockResolvedValue({ devices: [snapshot] });
    localTelemetryService.findLatestEvent.mockResolvedValue({
      current_state: 'OFFLINE',
    });

    const result = await service.evaluateFleet();

    expect(result.createdEvents).toBe(1);
    expect(alertService.resolveConnectivityAlert).toHaveBeenCalledTimes(1);
    expect(alertService.touchConnectivityAlert).not.toHaveBeenCalled();
  });

  it('does not touch or open anything for a device that stays ONLINE', async () => {
    const snapshot = buildSnapshot({
      id: 'cam-1',
      name: 'Hikvision 01',
      state: 'ONLINE',
    });

    telemetryService.findFleet.mockResolvedValue({ devices: [snapshot] });
    localTelemetryService.findLatestEvent.mockResolvedValue({
      current_state: 'ONLINE',
    });

    const result = await service.evaluateFleet();

    expect(result.createdEvents).toBe(0);
    expect(alertService.touchConnectivityAlert).not.toHaveBeenCalled();
    expect(alertService.openConnectivityAlert).not.toHaveBeenCalled();
    expect(alertService.resolveConnectivityAlert).not.toHaveBeenCalled();
  });

  describe('deterministic anti-flapping (CONNECTIVITY_FLAP_MIN_CONSECUTIVE)', () => {
    it('holds a direct heartbeat-overdue OFFLINE until N consecutive evaluations, then commits', async () => {
      service = createService({
        CONNECTIVITY_FLAP_MIN_CONSECUTIVE: '3',
      });

      const offline = buildSnapshot({
        id: 'cam-1',
        name: 'Direct Cam',
        state: 'OFFLINE',
        linkState: 'OFFLINE',
        reasons: ['HEARTBEAT_OVERDUE'],
        monitoringSource: 'DIRECT',
      });

      telemetryService.findFleet.mockResolvedValue({ devices: [offline] });
      localTelemetryService.findLatestEvent.mockResolvedValue({
        current_state: 'ONLINE',
      });

      expect((await service.evaluateFleet()).createdEvents).toBe(0);
      expect((await service.evaluateFleet()).createdEvents).toBe(0);
      expect(alertService.openConnectivityAlert).not.toHaveBeenCalled();

      // third consecutive OFFLINE commits the transition
      const third = await service.evaluateFleet();
      expect(third.createdEvents).toBe(1);
      expect(alertService.openConnectivityAlert).toHaveBeenCalledTimes(1);
    });

    it('never debounces an authoritative recorder-verified OFFLINE', async () => {
      service = createService({
        CONNECTIVITY_FLAP_MIN_CONSECUTIVE: '5',
      });

      const offline = buildSnapshot({
        id: 'cam-1',
        name: 'Child Cam',
        state: 'OFFLINE',
        linkState: 'OFFLINE',
        reasons: ['REPORTED_OFFLINE', 'RECORDER_VERIFIED_OFFLINE'],
        monitoringSource: 'RECORDER_OBSERVED',
      });

      telemetryService.findFleet.mockResolvedValue({ devices: [offline] });
      localTelemetryService.findLatestEvent.mockResolvedValue({
        current_state: 'ONLINE',
      });

      const result = await service.evaluateFleet();
      expect(result.createdEvents).toBe(1);
      expect(alertService.openConnectivityAlert).toHaveBeenCalledTimes(1);
    });

    it('resets the guard when the device recovers before confirmation', async () => {
      service = createService({
        CONNECTIVITY_FLAP_MIN_CONSECUTIVE: '3',
      });

      const offline = buildSnapshot({
        id: 'cam-1',
        name: 'Direct Cam',
        state: 'OFFLINE',
        linkState: 'OFFLINE',
        reasons: ['HEARTBEAT_OVERDUE'],
      });
      const onlineSnap = buildSnapshot({
        id: 'cam-1',
        name: 'Direct Cam',
        state: 'ONLINE',
      });

      localTelemetryService.findLatestEvent.mockResolvedValue({
        current_state: 'ONLINE',
      });

      telemetryService.findFleet.mockResolvedValue({ devices: [offline] });
      await service.evaluateFleet();

      telemetryService.findFleet.mockResolvedValue({
        devices: [onlineSnap],
      });
      await service.evaluateFleet();

      // a single OFFLINE after recovery starts the count from 1 again
      telemetryService.findFleet.mockResolvedValue({ devices: [offline] });
      expect((await service.evaluateFleet()).createdEvents).toBe(0);
    });
  });
});
