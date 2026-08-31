import { AlertRepository } from './alert.repository.js';

describe('AlertRepository connectivity incident severity', () => {
  function createRepository(existingSeverity: 'WARNING' | 'CRITICAL' | null) {
    const prisma = {
      alert: {
        findUnique: jest.fn().mockResolvedValue(
          existingSeverity
            ? { severity: existingSeverity }
            : null,
        ),
        upsert: jest.fn().mockResolvedValue({
          id: 'alert-1',
        }),
        updateMany: jest.fn().mockResolvedValue({
          count: 1,
        }),
      },
    };

    return {
      repository: new AlertRepository(prisma as any),
      prisma,
    };
  }

  const baseInput = {
    deviceId: '11111111-1111-4111-8111-111111111111',
    title: 'Connectivity incident',
    message: 'Connectivity changed',
    connectivityState: 'UNKNOWN',
    context: {
      reasons: ['HEARTBEAT_OVERDUE'],
      monitoringSource: 'DIRECT',
      individualVerification: 'DIRECT',
      observerDeviceId: null,
      observerDeviceName: null,
      channelId: null,
      channelNumber: null,
      lastHeartbeatAt: null,
      ageSeconds: 120,
    },
  };

  it('does not downgrade an open CRITICAL incident to WARNING', async () => {
    const { repository, prisma } =
      createRepository('CRITICAL');

    await repository.openConnectivityAlert({
      ...baseInput,
      severity: 'WARNING',
    });

    expect(prisma.alert.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          severity: 'CRITICAL',
        }),
      }),
    );
  });

  it('escalates an open WARNING incident to CRITICAL', async () => {
    const { repository, prisma } =
      createRepository('WARNING');

    await repository.openConnectivityAlert({
      ...baseInput,
      severity: 'CRITICAL',
      connectivityState: 'OFFLINE',
    });

    expect(prisma.alert.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          severity: 'CRITICAL',
        }),
      }),
    );
  });

  it('creates a new WARNING incident as WARNING', async () => {
    const { repository, prisma } =
      createRepository(null);

    await repository.openConnectivityAlert({
      ...baseInput,
      severity: 'WARNING',
    });

    expect(prisma.alert.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          severity: 'WARNING',
        }),
        create: expect.objectContaining({
          severity: 'WARNING',
        }),
      }),
    );
  });

  it('persists the operational context on open', async () => {
    const { repository, prisma } =
      createRepository(null);

    await repository.openConnectivityAlert({
      ...baseInput,
      severity: 'CRITICAL',
    });

    expect(prisma.alert.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          context: baseInput.context,
        }),
        create: expect.objectContaining({
          context: baseInput.context,
        }),
      }),
    );
  });
});

describe('AlertRepository touchActiveConnectivityAlert', () => {
  it('updates only the open connectivity alert for the device without touching severity', async () => {
    const prisma = {
      alert: {
        updateMany: jest.fn().mockResolvedValue({
          count: 1,
        }),
      },
    };

    const repository = new AlertRepository(
      prisma as any,
    );

    const context = {
      reasons: ['HEARTBEAT_OVERDUE'],
      monitoringSource: 'DIRECT',
      individualVerification: 'DIRECT',
      observerDeviceId: null,
      observerDeviceName: null,
      channelId: null,
      channelNumber: null,
      lastHeartbeatAt: null,
      ageSeconds: 45,
    };

    await repository.touchActiveConnectivityAlert(
      'device-1',
      context,
    );

    expect(prisma.alert.updateMany).toHaveBeenCalledWith({
      where: {
        deviceId: 'device-1',
        type: 'DEVICE_CONNECTIVITY',
        status: 'OPEN',
      },
      data: expect.objectContaining({
        context,
      }),
    });
  });
});
