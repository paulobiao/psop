import { NotFoundException } from '@nestjs/common';
import { DeviceIntelligenceService } from './device-intelligence.service.js';

/**
 * These tests pin the deterministic Device Intelligence rules — precedence,
 * provenance, freshness, "never invent", "never overwrite a confident value
 * with null". The full HTTP / real-shape scenarios live in the e2e spec.
 */

const SITE = { id: 'site-1', code: 'DFB-01', name: 'Deposito Fortaleza' };

function device(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dev-1',
    name: 'Device One',
    externalId: 'DEV-1',
    deviceType: 'CAMERA',
    monitoringMode: 'DIRECT',
    gatewayDeviceId: null,
    status: 'ACTIVE',
    manufacturer: null,
    model: null,
    firmwareVersion: null,
    ipAddress: null,
    serialNumber: null,
    site: SITE,
    ...overrides,
  };
}

function operational(overrides: Record<string, unknown> = {}) {
  return {
    device: {
      id: 'dev-1',
      name: 'Device One',
      externalId: 'DEV-1',
      deviceType: 'CAMERA',
      monitoringMode: 'DIRECT',
      gatewayDeviceId: null,
      administrativeStatus: 'ACTIVE',
      siteId: SITE.id,
      siteCode: SITE.code,
      siteName: SITE.name,
    },
    monitoring: {
      source: 'DIRECT',
      individualVerification: 'DIRECT',
      observerDeviceId: null,
    },
    connectivity: {
      state: 'ONLINE',
      linkState: 'ONLINE',
      reasons: [],
      reasonRefs: [],
      lastHeartbeatAt: '2026-08-30T12:00:00.000Z',
      lastObservedAt: '2026-08-30T12:00:00.000Z',
      ageSeconds: 4,
      expectedHeartbeatIntervalSeconds: 30,
      offlineAfterSeconds: 60,
    },
    health: { state: 'HEALTHY', reasons: [] },
    collection: { state: 'NOT_APPLICABLE', issues: [] },
    capabilities: {
      storage: { supported: false, present: false, state: 'NOT_APPLICABLE' },
      recording: { state: 'NOT_APPLICABLE' },
    },
    telemetry: {
      channelId: null,
      channelNumber: null,
      poePort: null,
      details: null,
    },
    ...overrides,
  };
}

function createService(mocks: {
  deviceRow?: unknown;
  operational?: unknown;
  telemetrySnapshot?: unknown;
  observationSnapshot?: unknown;
  observerRow?: unknown;
}) {
  const deviceRepository = {
    findByIdWithSite: jest.fn().mockResolvedValue(mocks.deviceRow ?? null),
  };

  const deviceTelemetryService = {
    findByDeviceId: jest.fn().mockResolvedValue(mocks.operational ?? null),
  };

  const prisma = {
    deviceTelemetrySnapshot: {
      findUnique: jest
        .fn()
        .mockResolvedValue(mocks.telemetrySnapshot ?? null),
    },
    recorderObservationSnapshot: {
      findUnique: jest
        .fn()
        .mockResolvedValue(mocks.observationSnapshot ?? null),
    },
    device: {
      findFirst: jest.fn().mockResolvedValue(mocks.observerRow ?? null),
    },
  };

  const service = new DeviceIntelligenceService(
    deviceRepository as never,
    deviceTelemetryService as never,
    prisma as never,
  );

  return { service, deviceRepository, deviceTelemetryService, prisma };
}

describe('DeviceIntelligenceService', () => {
  it('18. returns 404 for a device outside the tenant (no existence leak)', async () => {
    const { service, deviceTelemetryService } = createService({
      deviceRow: null,
    });

    await expect(
      service.getIntelligence('dev-x', 'org-1'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(deviceTelemetryService.findByDeviceId).not.toHaveBeenCalled();
  });

  it('1/2/3. Speco NVR: ONLINE/HEALTHY, storage NOT_INSTALLED, PoE budget from adapter details', async () => {
    const observedAt = '2026-08-30T12:00:00.000Z';
    const { service } = createService({
      deviceRow: device({
        id: 'nvr-1',
        name: 'NVR Speco',
        deviceType: 'RECORDER',
        manufacturer: 'Speco',
        model: null,
        firmwareVersion: null,
        ipAddress: '192.168.0.50',
      }),
      operational: operational({
        device: { deviceType: 'RECORDER', monitoringMode: 'DIRECT' },
        monitoring: {
          source: 'DIRECT',
          individualVerification: 'DIRECT',
          observerDeviceId: null,
        },
        collection: {
          state: 'PARTIAL',
          issues: [
            {
              code: 'OPTIONAL_ENRICHMENT_UNAVAILABLE',
              source: 'ADAPTER',
              detail: 'cameraFirmware:c1: errorCode=536870962',
            },
          ],
        },
        capabilities: {
          storage: { supported: true, present: false, state: 'NOT_INSTALLED' },
          recording: { state: 'NOT_AVAILABLE_NO_STORAGE' },
        },
      }),
      telemetrySnapshot: {
        deviceId: 'nvr-1',
        observedAt: new Date(observedAt),
        receivedAt: new Date('2026-08-30T12:00:01.000Z'),
        model: 'N8NRL',
        firmware: '1.0.0',
        details: {
          storageState: 'NOT_INSTALLED',
          storagePresent: false,
          diskCount: 0,
          poeTotalPowerW: 120,
          poeRemainingPowerW: 90.5,
          poeUsedPowerW: 29.5,
          onlineChannelCount: 3,
          observedChannelCount: 3,
          hardwareVersion: '1A',
          apiVersion: '2.0',
          onvifVersion: '18.12',
        },
      },
    });

    const result = await service.getIntelligence('nvr-1', 'org-1');

    expect(result.connectivity.linkState).toBe('ONLINE');
    expect(result.connectivity.legacyState).toBe('ONLINE');
    expect(result.health.state).toBe('HEALTHY');
    expect(result.capabilities?.storage.state).toBe('NOT_INSTALLED');
    expect(result.capabilities?.recording.state).toBe(
      'NOT_AVAILABLE_NO_STORAGE',
    );

    // identity provenance
    expect(result.identity.model).toEqual({
      value: 'N8NRL',
      source: 'ADAPTER',
      confidence: 'OBSERVED',
      observerDeviceId: null,
      observedAt,
    });
    expect(result.identity.manufacturer).toEqual({
      value: 'Speco',
      source: 'INVENTORY',
      confidence: 'DECLARED',
      observerDeviceId: null,
      observedAt: null,
    });
    expect(result.identity.hardwareVersion.value).toBe('1A');
    expect(result.identity.hardwareVersion.source).toBe('ADAPTER');
    expect(result.identity.serialNumber.value).toBeNull();

    // recorder host capacity view
    expect(result.recorderHost).toMatchObject({
      storageState: 'NOT_INSTALLED',
      diskCount: 0,
      poeTotalPowerW: 120,
      poeUsedPowerW: 29.5,
      onlineChannelCount: 3,
      observedChannelCount: 3,
    });
    expect(result.recorderChannel).toBeNull();

    // evidence: storage NOT_INSTALLED + PoE budget + collection issue
    const subjects = result.evidence.map((item) => item.subject);
    expect(subjects).toEqual(
      expect.arrayContaining(['connectivity', 'storage', 'poeBudget', 'collection']),
    );
    const storageEvidence = result.evidence.find(
      (item) => item.subject === 'storage',
    );
    expect(storageEvidence).toMatchObject({
      value: 'NOT_INSTALLED',
      detail: expect.stringContaining('not a fault'),
    });

    // 8. collection PARTIAL does not touch connectivity
    expect(result.collection.state).toBe('PARTIAL');
    expect(result.connectivity.linkState).toBe('ONLINE');
    expect(result.freshness.state).toBe('FRESH');
  });

  it('4/6. Hikvision recorder-verified online: model + channel from the recorder, VERIFIED', async () => {
    const observedAt = '2026-08-30T12:00:00.000Z';
    const { service } = createService({
      deviceRow: device({
        id: 'cam-1',
        name: 'Hikvision 01',
        deviceType: 'CAMERA',
        monitoringMode: 'VIA_GATEWAY',
        gatewayDeviceId: 'nvr-1',
        manufacturer: 'Hikvision',
        model: 'OLD-INVENTORY-MODEL',
      }),
      operational: operational({
        device: {
          deviceType: 'CAMERA',
          monitoringMode: 'VIA_GATEWAY',
          gatewayDeviceId: 'nvr-1',
        },
        monitoring: {
          source: 'RECORDER_OBSERVED',
          individualVerification: 'RECORDER_VERIFIED',
          observerDeviceId: 'nvr-1',
        },
        capabilities: {
          storage: { supported: false, present: false, state: 'NOT_APPLICABLE' },
          recording: { state: 'NOT_AVAILABLE_NO_STORAGE' },
        },
        telemetry: {
          channelId: '{00000001-0000-0000-0000-000000000000}',
          channelNumber: 1,
          poePort: 1,
        },
      }),
      observationSnapshot: {
        deviceId: 'cam-1',
        recorderDeviceId: 'nvr-1',
        observedAt: new Date(observedAt),
        receivedAt: new Date('2026-08-30T12:00:01.000Z'),
        reportedStatus: 'online',
        channelId: '{00000001-0000-0000-0000-000000000000}',
        channelNumber: 1,
        poePort: 1,
        poePowerW: 3.2,
        recordingStatus: 'NOT_AVAILABLE_NO_STORAGE',
        protocol: 'ONVIF',
        bitrateKbps: 3072,
        resolution: '1920x1080',
        frameRate: 30,
        model: 'DS-2CD2123G0-I',
        firmware: 'V5.5.82 build 190909',
      },
      observerRow: { id: 'nvr-1', name: 'NVR Speco' },
    });

    const result = await service.getIntelligence('cam-1', 'org-1');

    expect(result.identity.model).toEqual({
      value: 'DS-2CD2123G0-I',
      source: 'RECORDER',
      confidence: 'VERIFIED',
      observerDeviceId: 'nvr-1',
      observedAt,
    });
    expect(result.identity.firmware).toEqual({
      value: 'V5.5.82 build 190909',
      source: 'RECORDER',
      confidence: 'VERIFIED',
      observerDeviceId: 'nvr-1',
      observedAt,
    });

    expect(result.monitoring).toMatchObject({
      mode: 'VIA_GATEWAY',
      source: 'RECORDER_OBSERVED',
      verification: 'RECORDER_VERIFIED',
      observerDeviceId: 'nvr-1',
      observerDeviceName: 'NVR Speco',
      channelNumber: 1,
      poePort: 1,
    });

    expect(result.recorderChannel).toMatchObject({
      observerDeviceName: 'NVR Speco',
      channelNumber: 1,
      poePowerW: 3.2,
      bitrateKbps: 3072,
      frameRate: 30,
      recordingState: 'NOT_AVAILABLE_NO_STORAGE',
    });
    expect(result.network.protocols).toEqual(['ONVIF']);

    // 19. provenance evidence for the recorder-verified connectivity + PoE
    const connectivityEvidence = result.evidence.find(
      (item) => item.subject === 'connectivity',
    );
    expect(connectivityEvidence).toMatchObject({
      value: 'ONLINE',
      source: 'RECORDER',
      confidence: 'VERIFIED',
      observerDeviceName: 'NVR Speco',
      channelNumber: 1,
    });
    expect(
      result.evidence.some(
        (item) => item.subject === 'poePower' && item.value === 3.2,
      ),
    ).toBe(true);

    expect(result.freshness.state).toBe('FRESH');
  });

  it('13. an observed value takes precedence over an inventory value', async () => {
    const { service } = createService({
      deviceRow: device({
        id: 'cam-1',
        deviceType: 'CAMERA',
        monitoringMode: 'VIA_GATEWAY',
        gatewayDeviceId: 'nvr-1',
        model: 'INVENTORY-MODEL',
      }),
      operational: operational({
        monitoring: {
          source: 'RECORDER_OBSERVED',
          individualVerification: 'RECORDER_VERIFIED',
          observerDeviceId: 'nvr-1',
        },
      }),
      observationSnapshot: {
        deviceId: 'cam-1',
        recorderDeviceId: 'nvr-1',
        observedAt: new Date('2026-08-30T12:00:00.000Z'),
        receivedAt: new Date('2026-08-30T12:00:00.000Z'),
        model: 'OBSERVED-MODEL',
        firmware: null,
        channelId: null,
        channelNumber: null,
        poePort: null,
        poePowerW: null,
        recordingStatus: null,
        protocol: null,
        bitrateKbps: null,
        resolution: null,
        frameRate: null,
      },
      observerRow: { id: 'nvr-1', name: 'NVR Speco' },
    });

    const result = await service.getIntelligence('cam-1', 'org-1');

    expect(result.identity.model.value).toBe('OBSERVED-MODEL');
    expect(result.identity.model.source).toBe('RECORDER');
  });

  it('7/14. no observed firmware never overwrites an inventory firmware and is never invented', async () => {
    const { service } = createService({
      deviceRow: device({
        id: 'cam-1',
        deviceType: 'CAMERA',
        monitoringMode: 'VIA_GATEWAY',
        gatewayDeviceId: 'nvr-1',
        firmwareVersion: 'INVENTORY-FW-1.0',
      }),
      operational: operational({
        monitoring: {
          source: 'RECORDER_OBSERVED',
          individualVerification: 'RECORDER_VERIFIED',
          observerDeviceId: 'nvr-1',
        },
        collection: {
          state: 'PARTIAL',
          issues: [
            { code: 'OPTIONAL_ENRICHMENT_UNAVAILABLE', source: 'ADAPTER' },
          ],
        },
      }),
      observationSnapshot: {
        deviceId: 'cam-1',
        recorderDeviceId: 'nvr-1',
        observedAt: new Date('2026-08-30T12:00:00.000Z'),
        receivedAt: new Date('2026-08-30T12:00:00.000Z'),
        model: 'DS-2CD2123G0-I',
        firmware: null,
        channelId: null,
        channelNumber: 1,
        poePort: 1,
        poePowerW: null,
        recordingStatus: null,
        protocol: null,
        bitrateKbps: null,
        resolution: null,
        frameRate: null,
      },
      observerRow: { id: 'nvr-1', name: 'NVR Speco' },
    });

    const result = await service.getIntelligence('cam-1', 'org-1');

    // observed firmware is null -> fall through to the declared inventory value
    expect(result.identity.firmware).toEqual({
      value: 'INVENTORY-FW-1.0',
      source: 'INVENTORY',
      confidence: 'DECLARED',
      observerDeviceId: null,
      observedAt: null,
    });
    // connectivity is unaffected by the PARTIAL collection
    expect(result.connectivity.linkState).toBe('ONLINE');
    expect(result.health.state).toBe('HEALTHY');
  });

  it('7b. firmware stays null (and is flagged) when nothing observed it and inventory has none', async () => {
    const { service } = createService({
      deviceRow: device({
        id: 'cam-1',
        deviceType: 'CAMERA',
        monitoringMode: 'VIA_GATEWAY',
        gatewayDeviceId: 'nvr-1',
        firmwareVersion: null,
      }),
      operational: operational({
        monitoring: {
          source: 'RECORDER_OBSERVED',
          individualVerification: 'RECORDER_VERIFIED',
          observerDeviceId: 'nvr-1',
        },
      }),
      observationSnapshot: {
        deviceId: 'cam-1',
        recorderDeviceId: 'nvr-1',
        observedAt: new Date('2026-08-30T12:00:00.000Z'),
        receivedAt: new Date('2026-08-30T12:00:00.000Z'),
        model: 'DS-2CD2123G0-I',
        firmware: null,
        channelId: null,
        channelNumber: 1,
        poePort: null,
        poePowerW: null,
        recordingStatus: null,
        protocol: null,
        bitrateKbps: null,
        resolution: null,
        frameRate: null,
      },
      observerRow: { id: 'nvr-1', name: 'NVR Speco' },
    });

    const result = await service.getIntelligence('cam-1', 'org-1');

    expect(result.identity.firmware.value).toBeNull();
    expect(result.identity.firmware.source).toBeNull();
    expect(
      result.limitations.some((line) => line.toLowerCase().includes('firmware')),
    ).toBe(true);
  });

  it('5/11. recorder-verified offline / stale observation -> STALE freshness, CRITICAL or UNKNOWN, honest reasons', async () => {
    const { service } = createService({
      deviceRow: device({
        id: 'cam-1',
        deviceType: 'CAMERA',
        monitoringMode: 'VIA_GATEWAY',
        gatewayDeviceId: 'nvr-1',
      }),
      operational: operational({
        monitoring: {
          source: 'RECORDER_OBSERVED',
          individualVerification: 'RECORDER_VERIFIED',
          observerDeviceId: 'nvr-1',
        },
        connectivity: {
          state: 'OFFLINE',
          linkState: 'OFFLINE',
          reasons: ['REPORTED_OFFLINE', 'RECORDER_VERIFIED_OFFLINE'],
          reasonRefs: [
            { code: 'REPORTED_OFFLINE', source: 'DEVICE' },
            { code: 'RECORDER_VERIFIED_OFFLINE', source: 'RECORDER' },
          ],
          lastHeartbeatAt: '2026-08-30T11:58:00.000Z',
          lastObservedAt: '2026-08-30T11:58:00.000Z',
          ageSeconds: 120,
          offlineAfterSeconds: 60,
        },
        health: {
          state: 'CRITICAL',
          reasons: [{ code: 'CAMERA_CHANNEL_OFFLINE', source: 'RECORDER' }],
        },
      }),
      observationSnapshot: {
        deviceId: 'cam-1',
        recorderDeviceId: 'nvr-1',
        observedAt: new Date('2026-08-30T11:58:00.000Z'),
        receivedAt: new Date('2026-08-30T11:58:01.000Z'),
        model: 'DS-2CD2123G0-I',
        firmware: null,
        channelId: null,
        channelNumber: 1,
        poePort: 1,
        poePowerW: 0,
        recordingStatus: null,
        protocol: 'ONVIF',
        bitrateKbps: null,
        resolution: null,
        frameRate: null,
      },
      observerRow: { id: 'nvr-1', name: 'NVR Speco' },
    });

    const result = await service.getIntelligence('cam-1', 'org-1');

    expect(result.connectivity.linkState).toBe('OFFLINE');
    expect(result.connectivity.legacyState).toBe('OFFLINE');
    expect(result.health.state).toBe('CRITICAL');
    expect(result.connectivity.reasons).toEqual([
      'REPORTED_OFFLINE',
      'RECORDER_VERIFIED_OFFLINE',
    ]);
    expect(result.freshness.state).toBe('STALE');
  });

  it('9/10. direct device heartbeat: DEVICE-sourced connectivity evidence; stale -> STALE', async () => {
    const fresh = createService({
      deviceRow: device({ id: 'cam-d', deviceType: 'CAMERA' }),
      operational: operational(),
      telemetrySnapshot: {
        deviceId: 'cam-d',
        observedAt: new Date('2026-08-30T12:00:00.000Z'),
        receivedAt: new Date('2026-08-30T12:00:00.000Z'),
        model: null,
        firmware: null,
        details: null,
      },
    });

    const freshResult = await fresh.service.getIntelligence('cam-d', 'org-1');
    const conn = freshResult.evidence.find((i) => i.subject === 'connectivity');
    expect(conn).toMatchObject({ source: 'DEVICE', confidence: 'OBSERVED' });
    expect(freshResult.freshness.state).toBe('FRESH');

    const stale = createService({
      deviceRow: device({ id: 'cam-d', deviceType: 'CAMERA' }),
      operational: operational({
        connectivity: {
          state: 'OFFLINE',
          linkState: 'OFFLINE',
          reasons: ['HEARTBEAT_OVERDUE'],
          reasonRefs: [{ code: 'HEARTBEAT_OVERDUE', source: 'DEVICE' }],
          lastHeartbeatAt: '2026-08-30T11:00:00.000Z',
          lastObservedAt: '2026-08-30T11:00:00.000Z',
          ageSeconds: 3600,
          offlineAfterSeconds: 60,
        },
        health: { state: 'UNKNOWN', reasons: [] },
      }),
      telemetrySnapshot: {
        deviceId: 'cam-d',
        observedAt: new Date('2026-08-30T11:00:00.000Z'),
        receivedAt: new Date('2026-08-30T11:00:00.000Z'),
        model: null,
        firmware: null,
        details: null,
      },
    });

    const staleResult = await stale.service.getIntelligence('cam-d', 'org-1');
    expect(staleResult.freshness.state).toBe('STALE');
    expect(staleResult.connectivity.linkState).toBe('OFFLINE');
  });

  it('12/15. Lorex Home Center gateway: inventory identity + honest connectivity, no invented capability', async () => {
    const { service } = createService({
      deviceRow: device({
        id: 'lorex-1',
        name: 'Lorex Home Center',
        deviceType: 'GATEWAY',
        monitoringMode: 'DIRECT',
        manufacturer: 'Lorex',
        model: 'Lorex Smart Home Security Center L871T8',
        ipAddress: '192.168.0.118',
      }),
      operational: operational({
        device: { deviceType: 'GATEWAY', monitoringMode: 'DIRECT' },
        monitoring: {
          source: 'DIRECT',
          individualVerification: 'DIRECT',
          observerDeviceId: null,
        },
        capabilities: {
          storage: { supported: false, present: false, state: 'NOT_APPLICABLE' },
          recording: { state: 'NOT_APPLICABLE' },
        },
        telemetry: { channelId: null, channelNumber: null, poePort: null },
      }),
      telemetrySnapshot: {
        deviceId: 'lorex-1',
        observedAt: new Date('2026-08-30T12:00:00.000Z'),
        receivedAt: new Date('2026-08-30T12:00:00.000Z'),
        model: 'Lorex Smart Home Security Center L871T8',
        firmware: null,
        details: null,
      },
    });

    const result = await service.getIntelligence('lorex-1', 'org-1');

    expect(result.connectivity.linkState).toBe('ONLINE');
    // model comes from the edge gateway config, not the equipment itself
    expect(result.identity.model.source).toBe('GATEWAY');
    expect(result.identity.manufacturer).toMatchObject({
      value: 'Lorex',
      source: 'INVENTORY',
      confidence: 'DECLARED',
    });
    expect(result.network.ipAddress).toMatchObject({
      value: '192.168.0.118',
      source: 'INVENTORY',
    });
    expect(result.network.macAddress.value).toBeNull();
    expect(result.capabilities?.storage.state).toBe('NOT_APPLICABLE');
    expect(result.recorderChannel).toBeNull();
    expect(result.recorderHost).toBeNull();
    expect(
      result.limitations.some((line) => line.includes('MAC address')),
    ).toBe(true);
  });

  it('16. Lorex child camera with no recorder observation: nothing invented', async () => {
    const { service } = createService({
      deviceRow: device({
        id: 'lorex-cam-1',
        name: 'Lorex Camera 1',
        deviceType: 'CAMERA',
        monitoringMode: 'VIA_GATEWAY',
        gatewayDeviceId: 'lorex-1',
        manufacturer: 'Lorex',
      }),
      operational: operational({
        device: {
          deviceType: 'CAMERA',
          monitoringMode: 'VIA_GATEWAY',
          gatewayDeviceId: 'lorex-1',
        },
        monitoring: {
          source: 'GATEWAY_DERIVED',
          individualVerification: 'NOT_VERIFIED',
          observerDeviceId: null,
        },
        connectivity: {
          state: 'NEVER_SEEN',
          linkState: 'NEVER_SEEN',
          reasons: ['NO_TELEMETRY'],
          reasonRefs: [{ code: 'NO_TELEMETRY', source: 'GATEWAY' }],
          lastHeartbeatAt: null,
          lastObservedAt: null,
          ageSeconds: null,
          offlineAfterSeconds: 60,
        },
        health: { state: 'UNKNOWN', reasons: [] },
        collection: { state: 'NOT_APPLICABLE', issues: [] },
        capabilities: {
          storage: { supported: false, present: false, state: 'NOT_APPLICABLE' },
          recording: { state: 'NOT_APPLICABLE' },
        },
        telemetry: null,
      }),
      observationSnapshot: null,
    });

    const result = await service.getIntelligence('lorex-cam-1', 'org-1');

    expect(result.connectivity.linkState).toBe('NEVER_SEEN');
    expect(result.freshness.state).toBe('UNKNOWN');
    expect(result.identity.model.value).toBeNull();
    expect(result.identity.firmware.value).toBeNull();
    expect(result.capabilities?.storage.state).toBe('NOT_APPLICABLE');
    expect(result.recorderChannel).toBeNull();
    expect(result.evidence).toEqual([]);
    expect(
      result.limitations.some((line) =>
        line.includes('per-channel observation'),
      ),
    ).toBe(true);
  });

  it('17b. a non-eligible device (SENSOR / INVENTORY_ONLY) yields inventory-only intelligence', async () => {
    const { service, deviceTelemetryService } = createService({
      deviceRow: device({
        id: 'door-1',
        name: 'Porta',
        deviceType: 'SENSOR',
        monitoringMode: 'INVENTORY_ONLY',
        manufacturer: 'Generic',
        model: 'DoorContact',
      }),
    });

    const result = await service.getIntelligence('door-1', 'org-1');

    expect(deviceTelemetryService.findByDeviceId).not.toHaveBeenCalled();
    expect(result.connectivity.linkState).toBeNull();
    expect(result.health.state).toBeNull();
    expect(result.collection.state).toBeNull();
    expect(result.capabilities).toBeNull();
    expect(result.identity.model).toMatchObject({
      value: 'DoorContact',
      source: 'INVENTORY',
    });
    expect(result.freshness.state).toBe('UNKNOWN');
    expect(
      result.limitations.some((line) =>
        line.includes('does not collect live telemetry'),
      ),
    ).toBe(true);
  });

  it('20. never writes: only read methods are touched', async () => {
    const { service, deviceRepository, deviceTelemetryService, prisma } =
      createService({
        deviceRow: device({ id: 'cam-d', deviceType: 'CAMERA' }),
        operational: operational(),
        telemetrySnapshot: {
          deviceId: 'cam-d',
          observedAt: new Date('2026-08-30T12:00:00.000Z'),
          receivedAt: new Date('2026-08-30T12:00:00.000Z'),
          model: null,
          firmware: null,
          details: null,
        },
      });

    await service.getIntelligence('cam-d', 'org-1');

    expect(deviceRepository.findByIdWithSite).toHaveBeenCalledTimes(1);
    expect(deviceTelemetryService.findByDeviceId).toHaveBeenCalledTimes(1);
    expect(prisma.deviceTelemetrySnapshot.findUnique).toHaveBeenCalledTimes(1);
    // no create/update/upsert/delete anywhere on the prisma mock
    expect(
      Object.keys(prisma.deviceTelemetrySnapshot).every((k) => k === 'findUnique'),
    ).toBe(true);
  });
});
