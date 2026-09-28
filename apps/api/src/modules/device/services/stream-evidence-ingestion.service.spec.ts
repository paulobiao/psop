import { DeviceTelemetryIngestionService } from './device-telemetry-ingestion.service.js';
import {
  nvrFixture,
  streamFixture,
} from '../domain/stream-evidence.fixture.js';
import { hashDeviceIngestionKey } from '../security/device-ingestion-key.js';

function setup() {
  const observer = {
    id: 'observer',
    deviceType: 'RECORDER',
    monitoringMode: 'DIRECT',
    status: 'ACTIVE',
    siteId: 'site',
    site: { organizationId: 'tenant' },
    ingestionCredential: { keyHash: hashDeviceIngestionKey('unit-test-key') },
  };
  const prisma = {
    device: {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(observer)
        .mockResolvedValueOnce({ id: streamFixture().deviceId }),
    },
    recorderObservationSnapshot: {
      findFirst: jest.fn().mockResolvedValue({ deviceId: streamFixture().deviceId }),
    },
  };
  const evidence = {
    recordStreamEvidence: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const local = { assertEnabled: jest.fn(), upsertSnapshot: jest.fn() };
  const connectivity = { evaluateFleet: jest.fn() };
  const service = new DeviceTelemetryIngestionService(
    prisma as never,
    {} as never,
    local as never,
    connectivity as never,
    {} as never,
    {} as never,
    {} as never,
    evidence as never,
  );
  return { service, prisma, evidence, local, connectivity, observer };
}

describe('authenticated stream ingestion', () => {
  it('requires a same-tenant, same-site assigned camera', async () => {
    const { service, prisma, evidence } = setup();
    await expect(
      service.ingestStreamEvidence(
        'observer',
        'unit-test-key',
        streamFixture(),
      ),
    ).resolves.toEqual({ accepted: 1 });
    expect(prisma.device.findFirst.mock.calls[1][0].where).toMatchObject({
      id: streamFixture().deviceId,
      siteId: 'site',
      site: { organizationId: 'tenant', deletedAt: null },
      gatewayDeviceId: 'observer',
      monitoringMode: 'VIA_GATEWAY',
      status: 'ACTIVE',
      deviceType: 'CAMERA',
      deletedAt: null,
    });
    expect(evidence.recordStreamEvidence).toHaveBeenCalledWith(
      'observer',
      streamFixture(),
    );
  });
  it('rejects invalid ingestion authentication before target lookup', async () => {
    const { service, prisma, evidence } = setup();
    await expect(
      service.ingestStreamEvidence('observer', 'wrong-key', streamFixture()),
    ).rejects.toThrow('Invalid device credentials');
    expect(prisma.device.findFirst).toHaveBeenCalledTimes(1);
    expect(evidence.recordStreamEvidence).not.toHaveBeenCalled();
  });
  it('rejects foreign or unassigned targets without writing', async () => {
    const { service, prisma, evidence, observer } = setup();
    prisma.device.findFirst
      .mockReset()
      .mockResolvedValueOnce(observer)
      .mockResolvedValueOnce(null);
    await expect(
      service.ingestStreamEvidence(
        'observer',
        'unit-test-key',
        streamFixture(),
      ),
    ).rejects.toThrow('Stream target is not authorized');
    expect(evidence.recordStreamEvidence).not.toHaveBeenCalled();
  });
  it('rejects forged provenance', async () => {
    const { service, evidence } = setup();
    await expect(
      service.ingestStreamEvidence('observer', 'unit-test-key', {
        ...streamFixture(),
        source: 'DEVICE',
      }),
    ).rejects.toThrow('Stream source');
    expect(evidence.recordStreamEvidence).not.toHaveBeenCalled();
  });
  it('does not update health, heartbeat or connectivity on optional probe failure', async () => {
    const { service, local, connectivity } = setup();
    await service.ingestStreamEvidence('observer', 'unit-test-key', {
      ...streamFixture(),
      result: 'FAILED',
      reason: 'UNREACHABLE',
    });
    expect(local.upsertSnapshot).not.toHaveBeenCalled();
    expect(connectivity.evaluateFleet).not.toHaveBeenCalled();
  });
  it('a directly monitored camera cannot target another camera', async () => {
    const { service, prisma, evidence, observer } = setup();
    prisma.device.findFirst
      .mockReset()
      .mockResolvedValueOnce({ ...observer, deviceType: 'CAMERA' })
      .mockResolvedValueOnce({ id: observer.id });
    await expect(
      service.ingestStreamEvidence('observer', 'unit-test-key', {
        ...streamFixture(),
        source: 'DEVICE',
      }),
    ).rejects.toThrow('Stream target is not authorized');
    expect(evidence.recordStreamEvidence).not.toHaveBeenCalled();
  });
  it('accepts an NVR-mediated run only on the channel the recorder reports', async () => {
    const { service, prisma, evidence } = setup();
    await expect(
      service.ingestStreamEvidence('observer', 'unit-test-key', nvrFixture()),
    ).resolves.toEqual({ accepted: 1 });
    expect(
      prisma.recorderObservationSnapshot.findFirst.mock.calls[0][0].where,
    ).toEqual({
      deviceId: streamFixture().deviceId,
      recorderDeviceId: 'observer',
      channelNumber: 2,
    });
    expect(evidence.recordStreamEvidence).toHaveBeenCalledWith(
      'observer',
      nvrFixture(),
    );
  });
  it('rejects an NVR-mediated run bound to the wrong channel without writing', async () => {
    const { service, prisma, evidence } = setup();
    prisma.recorderObservationSnapshot.findFirst.mockResolvedValue(null);
    await expect(
      service.ingestStreamEvidence('observer', 'unit-test-key', nvrFixture()),
    ).rejects.toThrow('Stream channel does not match');
    expect(evidence.recordStreamEvidence).not.toHaveBeenCalled();
  });
  it('rejects an NVR-mediated run for a camera of another recorder or tenant', async () => {
    const { service, prisma, evidence, observer } = setup();
    prisma.device.findFirst
      .mockReset()
      .mockResolvedValueOnce(observer)
      .mockResolvedValueOnce(null);
    await expect(
      service.ingestStreamEvidence('observer', 'unit-test-key', nvrFixture()),
    ).rejects.toThrow('Stream target is not authorized');
    expect(prisma.recorderObservationSnapshot.findFirst).not.toHaveBeenCalled();
    expect(evidence.recordStreamEvidence).not.toHaveBeenCalled();
  });
  it('does not consult channel assignment for direct discovered endpoints', async () => {
    const { service, prisma } = setup();
    await service.ingestStreamEvidence('observer', 'unit-test-key', streamFixture());
    expect(prisma.recorderObservationSnapshot.findFirst).not.toHaveBeenCalled();
  });
});
