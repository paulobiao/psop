import {
  nvrFixture,
  streamFixture,
  negotiation,
} from '../domain/stream-evidence.fixture.js';
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

 describe('stream evidence persistence', () => {
   it('scopes idempotency to observer, probe, target and level', async () => {
     const { service, prisma } = createService();
     const input = streamFixture();
     await service.recordStreamEvidence('observer-1', input);
     await service.recordStreamEvidence('observer-1', input);
     const first = prisma.evidenceRecord.createMany.mock.calls[0][0];
     expect(prisma.evidenceRecord.createMany.mock.calls[1][0]).toEqual(first);
     expect(first.skipDuplicates).toBe(true);
     expect(first.data[0]).toMatchObject({
       deviceId: input.deviceId,
       observerDeviceId: 'observer-1',
       source: 'ADAPTER',
       confidence: 'OBSERVED',
       subject: 'video.stream',
       level: input.level,
     });
     expect(first.data[0].sourceEventKey).toContain(input.probeId);
   });
   it('stores unsupported attempts as E0, retaining the requested level', async () => {
     const { service, prisma } = createService();
     const input = {
       ...streamFixture(),
       level: 'E6_FRAMES_RECEIVED' as const,
       result: 'UNSUPPORTED' as const,
       reason: 'CAPABILITY_UNAVAILABLE' as const,
     };
     await service.recordStreamEvidence('observer-1', input);
     expect(
       prisma.evidenceRecord.createMany.mock.calls[0][0].data[0],
     ).toMatchObject({
       level: 'E0_UNKNOWN',
       payload: { level: 'E6_FRAMES_RECEIVED', result: 'UNSUPPORTED' },
     });
   });
   it('never promotes recorder frameRate to E6', async () => {
     const { service, prisma } = createService();
     await service.recordRecorderObservations('recorder-1', 1788537600, [
       {
         deviceId: 'camera-1',
         status: 'online',
         frameRate: 30,
         bitrateKbps: 4096,
         recordingStatus: 'recording',
       },
     ]);
     expect(prisma.evidenceRecord.createMany.mock.calls[0][0].data).toEqual([
       expect.objectContaining({ level: 'E3_PROFILE_DISCOVERED' }),
     ]);
   });
   it('maps successful E6 to the existing ledger enum and derives stale at read time', async () => {
     const { service, prisma } = createService();
     const input = {
       ...streamFixture(),
       level: 'E6_FRAMES_RECEIVED' as const,
       negotiation,
       media: {
         measurement: 'RTP_VIDEO_PACKETS' as const,
         count: 1,
         windowMs: 1000,
         lastReceivedAt: streamFixture().observedAt,
       },
     };
     await service.recordStreamEvidence('observer-1', input);
     const record = prisma.evidenceRecord.createMany.mock.calls[0][0].data[0];
     expect(record.level).toBe('E6_MEDIA_RECEIVED');
     prisma.evidenceRecord.findMany.mockResolvedValue([record]);
     expect(
       (await service.findByDeviceId(input.deviceId, 'org', 10)).evidence[0]
         .freshness,
     ).toBe('STALE');
   });
 });

describe('latest stream measurement', () => {
  const recorder = { id: 'recorder-1', name: 'NVR', deviceType: 'RECORDER' };
  // Rows exactly as the NVR check emits them for one attempt.
  function record(payload: Record<string, unknown>, expiresAt: string) {
    return {
      observerDeviceId: recorder.id,
      source: 'ADAPTER',
      confidence: 'OBSERVED',
      observedAt: new Date(payload.observedAt as string),
      expiresAt: new Date(expiresAt),
      payload,
    };
  }
  function setup(rows: ReturnType<typeof record>[], device: unknown = { id: 'camera-1', siteId: 'site-1' }) {
    const prisma = {
      evidenceRecord: {
        findFirst: jest.fn().mockResolvedValue(rows[0] ?? null),
        findMany: jest.fn().mockResolvedValue(rows),
      },
      device: { findFirst: jest.fn().mockResolvedValue(recorder) },
    };
    const devices = { findByIdWithSite: jest.fn().mockResolvedValue(device) };
    return {
      service: new DeviceEvidenceService(prisma as never, devices as never),
      prisma,
      devices,
    };
  }
  const future = new Date(Date.now() + 60_000).toISOString();
  const now = new Date().toISOString();
  const e6 = () => ({ ...nvrFixture(), observedAt: now });
  const e5 = () => ({ ...nvrFixture('E5_RTSP_SESSION_NEGOTIATED'), observedAt: now });
  const without = ({ negotiation: _n, media: _m, ...rest }: ReturnType<typeof e6>) => rest;

  it('reports absence of measurement distinctly', async () => {
    const { service, prisma } = setup([]);
    await expect(service.latestStreamMeasurement('camera-1', 'tenant')).resolves.toMatchObject({
      state: 'NO_MEASUREMENT',
      measurement: null,
    });
    expect(prisma.evidenceRecord.findMany).not.toHaveBeenCalled();
  });

  it('projects a fresh NVR-mediated success with provenance, packets and validity', async () => {
    const { service, prisma } = setup([
      record({ ...e6(), media: { ...e6().media, lastReceivedAt: now } }, future),
      record(e5(), future),
    ]);
    const result = await service.latestStreamMeasurement('camera-1', 'tenant');
    expect(result).toMatchObject({
      state: 'SUCCEEDED',
      measurement: {
        freshness: 'FRESH',
        expiresAt: future,
        source: 'ADAPTER',
        observer: recorder,
        access: 'NVR_MEDIATED',
        uriSource: 'MANUAL_OPERATOR_INPUT',
        channelNumber: 2,
        result: 'SUCCEEDED',
        reason: 'NONE',
        negotiation: { result: 'SUCCEEDED', reason: 'NONE' },
        media: {
          result: 'SUCCEEDED',
          proof: { measurement: 'RTP_VIDEO_PACKETS', count: 140, windowMs: 5000 },
        },
        decodedFrames: 'NOT_MEASURED',
      },
    });
    // Rows are grouped by the explicit attempt and the same observer only.
    expect(prisma.evidenceRecord.findMany.mock.calls[0][0].where).toMatchObject({
      deviceId: 'camera-1',
      subject: 'video.stream',
      observerDeviceId: recorder.id,
      payload: { path: ['attemptId'], equals: nvrFixture().attemptId },
    });
    expect(JSON.stringify(result)).not.toMatch(/host|pathSha256|192\.0\.2/);
  });

  it('reports authentication failure as a failed measurement, not absence', async () => {
    const { service } = setup([
      record({ ...without(e6()), result: 'NOT_OBSERVED', reason: 'NOT_ATTEMPTED' }, future),
      record({ ...without(e5()), result: 'FAILED', reason: 'AUTHENTICATION_FAILED' }, future),
    ]);
    await expect(service.latestStreamMeasurement('camera-1', 'tenant')).resolves.toMatchObject({
      state: 'FAILED',
      measurement: {
        result: 'FAILED',
        reason: 'AUTHENTICATION_FAILED',
        negotiation: { result: 'FAILED', reason: 'AUTHENTICATION_FAILED' },
        media: { result: 'NOT_OBSERVED', reason: 'NOT_ATTEMPTED', proof: null },
      },
    });
  });

  it('reports negotiated session without media as failed media', async () => {
    const { service } = setup([
      record({ ...without(e6()), result: 'FAILED', reason: 'TIMEOUT' }, future),
      record(e5(), future),
    ]);
    await expect(service.latestStreamMeasurement('camera-1', 'tenant')).resolves.toMatchObject({
      state: 'FAILED',
      measurement: {
        reason: 'TIMEOUT',
        negotiation: { result: 'SUCCEEDED' },
        media: { result: 'FAILED', reason: 'TIMEOUT', proof: null },
      },
    });
  });

  it('marks an old success as expired while keeping its original result', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const { service } = setup([record(e6(), past), record(e5(), past)]);
    await expect(service.latestStreamMeasurement('camera-1', 'tenant')).resolves.toMatchObject({
      state: 'EXPIRED',
      measurement: { freshness: 'STALE', result: 'SUCCEEDED' },
    });
  });

  it('enforces tenant isolation before reading evidence', async () => {
    const { service, prisma, devices } = setup([record(e6(), future)], null);
    await expect(service.latestStreamMeasurement('camera-1', 'other-tenant')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(devices.findByIdWithSite).toHaveBeenCalledWith('camera-1', 'other-tenant');
    expect(prisma.evidenceRecord.findFirst).not.toHaveBeenCalled();
  });

  it('resolves the observer only within the device site', async () => {
    const { service, prisma } = setup([record(e6(), future)]);
    await service.latestStreamMeasurement('camera-1', 'tenant');
    expect(prisma.device.findFirst.mock.calls[0][0].where).toEqual({
      id: recorder.id,
      siteId: 'site-1',
    });
  });
});
