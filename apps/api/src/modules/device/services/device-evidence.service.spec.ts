import { NotFoundException } from '@nestjs/common';
import { DeviceEvidenceService } from './device-evidence.service.js';

function createService(device: unknown = { id: 'device-1' }) {
  const prisma = {
    evidenceRecord: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const devices = {
    findByIdWithSite: jest.fn().mockResolvedValue(device),
  };

  return {
    service: new DeviceEvidenceService(prisma as never, devices as never),
    prisma,
    devices,
  };
}

describe('DeviceEvidenceService', () => {
  it('records direct telemetry as idempotent observed evidence', async () => {
    const { service, prisma } = createService();

    await service.recordDirectTelemetry({
      id: 'device-1',
      deviceType: 'CAMERA',
    }, {
      timestamp: 1_788_537_600,
      status: 'online',
      model: 'N8NRL',
    });

    expect(prisma.evidenceRecord.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        deviceId: 'device-1',
        kind: 'OBSERVATION',
        source: 'DEVICE',
        confidence: 'OBSERVED',
        level: 'E1_ENDPOINT_REACHABLE',
        subject: 'device.telemetry',
        sourceEventKey:
          'device:device-1:telemetry:1788537600',
      })],
      skipDuplicates: true,
    });
  });

  it('attributes recorder telemetry to the adapter, not the recorder itself', async () => {
    const { service, prisma } = createService();

    await service.recordDirectTelemetry({
      id: 'recorder-1',
      deviceType: 'RECORDER',
    }, {
      timestamp: 1_788_537_600,
      status: 'online',
    });

    expect(prisma.evidenceRecord.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ source: 'ADAPTER' })],
      }),
    );
  });

  it('preserves the recorder as observer and each camera as target', async () => {
    const { service, prisma } = createService();

    await service.recordRecorderObservations(
      'recorder-1',
      1_788_537_600,
      [{
        deviceId: 'camera-1',
        status: 'online',
        channelNumber: 2,
      }],
    );

    expect(prisma.evidenceRecord.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        deviceId: 'camera-1',
        observerDeviceId: 'recorder-1',
        source: 'RECORDER',
        confidence: 'VERIFIED',
        level: 'E3_PROFILE_DISCOVERED',
        subject: 'recorder.channel',
        sourceEventKey:
          'recorder:recorder-1:camera-1:1788537600',
      })],
      skipDuplicates: true,
    });
  });

  it('enforces tenant isolation before querying evidence', async () => {
    const { service, prisma } = createService(null);

    await expect(
      service.findByDeviceId('device-1', 'other-org', 50),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.evidenceRecord.findMany).not.toHaveBeenCalled();
  });

  it('derives freshness at read time without mutating evidence', async () => {
    jest.useFakeTimers().setSystemTime(
      new Date('2026-09-05T18:00:00.000Z'),
    );
    const { service, prisma } = createService();
    prisma.evidenceRecord.findMany.mockResolvedValue([
      {
        id: 'fresh',
        expiresAt: new Date('2026-09-05T18:01:00.000Z'),
      },
      {
        id: 'stale',
        expiresAt: new Date('2026-09-05T17:59:00.000Z'),
      },
      { id: 'unknown', expiresAt: null },
    ]);

    const result = await service.findByDeviceId(
      'device-1',
      'org-1',
      25,
    );

    expect(result.evidence.map((item) => item.freshness)).toEqual([
      'FRESH',
      'STALE',
      'UNKNOWN',
    ]);
    expect(prisma.evidenceRecord.findMany).toHaveBeenCalledWith({
      where: { deviceId: 'device-1' },
      orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }],
      take: 25,
    });
    jest.useRealTimers();
  });
});
