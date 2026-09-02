import { Logger } from '@nestjs/common';
import { AlertService } from './alert.service';

describe('AlertService notification resilience', () => {
  const alert = {
    id:
      '11111111-1111-4111-8111-111111111111',
    deviceId:
      '22222222-2222-4222-8222-222222222222',
    type:
      'DEVICE_CONNECTIVITY',
    status: 'OPEN',
    severity: 'CRITICAL',
    title:
      'Device EDGE-1 is offline',
    message:
      'Edge at site LAB has connectivity state OFFLINE.',
    connectivityState:
      'OFFLINE',
    dedupKey:
      'device:DEVICE_CONNECTIVITY',
    openedAt:
      new Date(),
    lastDetectedAt:
      new Date(),
    resolvedAt:
      null,
    createdAt:
      new Date(),
    updatedAt:
      new Date(),
    device: {
      id:
        '22222222-2222-4222-8222-222222222222',
      name: 'Edge',
      externalId:
        'EDGE-1',
      siteId:
        '33333333-3333-4333-8333-333333333333',
      deviceType:
        'GATEWAY',
      monitoringMode:
        'DIRECT',
      gatewayDeviceId:
        null,
      manufacturer:
        null,
      model:
        null,
      firmwareVersion:
        null,
      ipAddress:
        null,
      serialNumber:
        null,
      status:
        'ACTIVE',
      expectedHeartbeatInterval:
        60,
      createdAt:
        new Date(),
      updatedAt:
        new Date(),
      deletedAt:
        null,
      site: {
        id:
          '33333333-3333-4333-8333-333333333333',
        organizationId:
          '44444444-4444-4444-8444-444444444444',
        name: 'Lab',
        code: 'LAB',
        timezone:
          null,
        address:
          null,
        status:
          'ACTIVE',
        createdAt:
          new Date(),
        updatedAt:
          new Date(),
        deletedAt:
          null,
      },
    },
  } as any;

  const repository = {
    openConnectivityAlert:
      jest.fn(),
    resolveConnectivityAlert:
      jest.fn(),
    resolveById:
      jest.fn(),
    touchActiveConnectivityAlert:
      jest.fn(),
    findById:
      jest.fn(),
    findAll:
      jest.fn(),
    findRecentConnectivityIncidents:
      jest.fn(),
    getConnectivityIncidentAnalytics:
      jest.fn(),
  };

  const notifications = {
    handleIncidentOpened:
      jest.fn(),
    handleIncidentRecovered:
      jest.fn(),
  };

  const baseContext = {
    reasons: ['HEARTBEAT_OVERDUE'],
    monitoringSource: 'DIRECT',
    individualVerification: 'DIRECT',
    observerDeviceId: null,
    observerDeviceName: null,
    channelId: null,
    channelNumber: null,
    lastHeartbeatAt: null,
    ageSeconds: 120,
  };

  let service:
    AlertService;

  beforeEach(() => {
    jest.clearAllMocks();

    jest
      .spyOn(
        Logger.prototype,
        'warn',
      )
      .mockImplementation(
        () => undefined,
      );

    service =
      new AlertService(
        repository as any,
        notifications as any,
      );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps incident opening successful when notification processing fails', async () => {
    repository
      .openConnectivityAlert
      .mockResolvedValue(
        alert,
      );

    notifications
      .handleIncidentOpened
      .mockRejectedValue(
        new Error(
          'transport failed',
        ),
      );

    await expect(
      service
        .openConnectivityAlert({
          deviceId:
            alert.deviceId,
          deviceName:
            alert.device.name,
          siteCode:
            alert.device.site.code,
          externalId:
            alert.device.externalId,
          state: 'OFFLINE',
          context: baseContext,
        }),
    ).resolves.toBe(alert);
  });

  it('keeps incident recovery successful when notification processing fails', async () => {
    const recovered = {
      ...alert,
      status:
        'RESOLVED',
      connectivityState:
        'ONLINE',
      resolvedAt:
        new Date(),
    };

    repository
      .resolveConnectivityAlert
      .mockResolvedValue(
        recovered,
      );

    notifications
      .handleIncidentRecovered
      .mockRejectedValue(
        new Error(
          'transport failed',
        ),
      );

    await expect(
      service
        .resolveConnectivityAlert(
          alert.deviceId,
        ),
    ).resolves.toBe(
      recovered,
    );
  });

  it('does not trigger incident-opened notifications when touching an active incident', async () => {
    await service.touchConnectivityAlert(
      alert.deviceId,
      baseContext,
    );

    expect(
      repository.openConnectivityAlert,
    ).not.toHaveBeenCalled();

    expect(
      notifications.handleIncidentOpened,
    ).not.toHaveBeenCalled();
  });
});

describe('AlertService operational incident copy', () => {
  const repository = {
    openConnectivityAlert: jest.fn(),
    resolveConnectivityAlert: jest.fn(),
    resolveById: jest.fn(),
    touchActiveConnectivityAlert: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn(),
    findRecentConnectivityIncidents: jest.fn(),
    getConnectivityIncidentAnalytics: jest.fn(),
  };

  const notifications = {
    handleIncidentOpened: jest.fn(),
    handleIncidentRecovered: jest.fn(),
  };

  let service: AlertService;

  beforeEach(() => {
    jest.clearAllMocks();

    repository.openConnectivityAlert.mockImplementation(
      (input) => Promise.resolve({ ...input, id: 'alert-1' }),
    );

    service = new AlertService(
      repository as any,
      notifications as any,
    );
  });

  const baseInput = {
    deviceId: 'device-1',
    deviceName: 'Hikvision 01',
    siteCode: 'DFB-01',
    externalId: 'CAM-01',
  };

  it('builds a recorder-verified offline message naming the resolved observer and channel', async () => {
    const alert = await service.openConnectivityAlert({
      ...baseInput,
      state: 'OFFLINE',
      context: {
        reasons: ['REPORTED_OFFLINE', 'RECORDER_VERIFIED_OFFLINE'],
        monitoringSource: 'RECORDER_OBSERVED',
        individualVerification: 'RECORDER_VERIFIED',
        observerDeviceId: 'recorder-1',
        observerDeviceName: 'NVR Speco',
        channelId: 'ch-1',
        channelNumber: 1,
        lastHeartbeatAt: null,
        ageSeconds: 8,
      },
    });

    expect(alert.title).toBe('Hikvision 01 is offline');
    expect(alert.message).toBe(
      'Hikvision 01 is offline according to NVR Speco on channel 1.',
    );
  });

  it('falls back to "its recorder" when the observer cannot be resolved', async () => {
    const alert = await service.openConnectivityAlert({
      ...baseInput,
      state: 'OFFLINE',
      context: {
        reasons: ['REPORTED_OFFLINE', 'RECORDER_VERIFIED_OFFLINE'],
        monitoringSource: 'RECORDER_OBSERVED',
        individualVerification: 'RECORDER_VERIFIED',
        observerDeviceId: null,
        observerDeviceName: null,
        channelId: null,
        channelNumber: null,
        lastHeartbeatAt: null,
        ageSeconds: 8,
      },
    });

    expect(alert.message).toBe(
      'Hikvision 01 is offline according to its recorder.',
    );
  });

  it('builds a heartbeat-overdue message for direct devices', async () => {
    const alert = await service.openConnectivityAlert({
      ...baseInput,
      state: 'OFFLINE',
      context: {
        reasons: ['HEARTBEAT_OVERDUE'],
        monitoringSource: 'DIRECT',
        individualVerification: 'DIRECT',
        observerDeviceId: null,
        observerDeviceName: null,
        channelId: null,
        channelNumber: null,
        lastHeartbeatAt: null,
        ageSeconds: 900,
      },
    });

    expect(alert.message).toBe(
      'Hikvision 01 stopped reporting telemetry.',
    );
  });

  it('builds a high-temperature degraded message', async () => {
    const alert = await service.openConnectivityAlert({
      ...baseInput,
      state: 'DEGRADED',
      context: {
        reasons: ['HIGH_TEMPERATURE'],
        monitoringSource: 'DIRECT',
        individualVerification: 'DIRECT',
        observerDeviceId: null,
        observerDeviceName: null,
        channelId: null,
        channelNumber: null,
        lastHeartbeatAt: null,
        ageSeconds: 5,
      },
    });

    expect(alert.title).toBe('Hikvision 01 is degraded');
    expect(alert.message).toBe(
      'Hikvision 01 is degraded because temperature exceeded the configured threshold.',
    );
  });

  it('builds a high-storage degraded message', async () => {
    const alert = await service.openConnectivityAlert({
      ...baseInput,
      state: 'DEGRADED',
      context: {
        reasons: ['HIGH_STORAGE_USAGE'],
        monitoringSource: 'DIRECT',
        individualVerification: 'DIRECT',
        observerDeviceId: null,
        observerDeviceName: null,
        channelId: null,
        channelNumber: null,
        lastHeartbeatAt: null,
        ageSeconds: 5,
      },
    });

    expect(alert.message).toBe(
      'Hikvision 01 is degraded because storage usage exceeded the configured threshold.',
    );
  });
});
