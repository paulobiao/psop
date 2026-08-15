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
});
