import {
  type INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaClient } from '../generated/prisma/client.js';
import { AppModule } from '../src/app.module.js';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for integration tests');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
});

const API = '/api/v1';
const PASSWORD = 'DeviceIntelligencePassword123!';

interface LoginBody {
  accessToken: string;
}

function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

describe('PSOP Device Intelligence V1', () => {
  let app: INestApplication;

  const runId = randomUUID().slice(0, 8);
  const organizationIds: string[] = [];

  let organizationAId: string;
  let organizationBId: string;
  let siteAId: string;
  let siteBId: string;
  let adminToken: string;

  let recorderId: string;
  let hikChildId: string;
  let lorexGatewayId: string;
  let lorexChildId: string;
  let doorId: string;
  let foreignDeviceId: string;

  let recorderKey: string;
  let lorexKey: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'device-intelligence-access-secret-long-enough';
    process.env.JWT_REFRESH_SECRET =
      'device-intelligence-refresh-secret-long-enough';
    process.env.JWT_EXPIRES_SECONDS = '900';
    process.env.JWT_REFRESH_EXPIRES_SECONDS = '3600';
    process.env.MFA_ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef' + '0123456789abcdef0123456789abcdef';
    process.env.CONNECTIVITY_MONITOR_ENABLED = 'false';
    process.env.TELEMETRY_DEMO_MODE = 'false';
    process.env.LOCAL_TELEMETRY_INGESTION_ENABLED = 'true';
    process.env.NOTIFICATION_WORKER_ENABLED = 'false';
    process.env.AWS_REGION = 'us-east-1';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );

    await app.init();
    await prisma.$connect();

    const [organizationA, organizationB] = await Promise.all([
      prisma.organization.create({
        data: {
          name: `Device Intelligence A ${runId}`,
          slug: `device-intelligence-a-${runId}`,
        },
      }),
      prisma.organization.create({
        data: {
          name: `Device Intelligence B ${runId}`,
          slug: `device-intelligence-b-${runId}`,
        },
      }),
    ]);

    organizationAId = organizationA.id;
    organizationBId = organizationB.id;
    organizationIds.push(organizationAId, organizationBId);

    const [siteA, siteB] = await Promise.all([
      prisma.site.create({
        data: {
          organizationId: organizationAId,
          name: 'Deposito Fortaleza',
          code: `DFB-${runId}`,
          timezone: 'America/Fortaleza',
        },
      }),
      prisma.site.create({
        data: {
          organizationId: organizationBId,
          name: 'Other Tenant Site',
          code: `OTS-${runId}`,
          timezone: 'America/Fortaleza',
        },
      }),
    ]);

    siteAId = siteA.id;
    siteBId = siteB.id;

    const adminEmail = `di-admin-${runId}@psop.test`;
    const passwordHash = await hash(PASSWORD, 12);

    await prisma.user.create({
      data: {
        organizationId: organizationAId,
        name: 'Intelligence Admin',
        email: adminEmail,
        passwordHash,
        role: 'ADMIN',
        mustChangePassword: false,
      },
    });

    const recorder = await prisma.device.create({
      data: {
        siteId: siteAId,
        name: 'NVR Speco',
        externalId: `NVR-SPECO-${runId}`,
        deviceType: 'RECORDER',
        monitoringMode: 'DIRECT',
        manufacturer: 'Speco Technologies',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 30,
      },
    });
    recorderId = recorder.id;

    const hikChild = await prisma.device.create({
      data: {
        siteId: siteAId,
        name: 'Hikvision 01',
        externalId: `HIK-01-${runId}`,
        deviceType: 'CAMERA',
        monitoringMode: 'VIA_GATEWAY',
        gatewayDeviceId: recorderId,
        manufacturer: 'Hikvision',
        model: 'DS-INVENTORY',
        firmwareVersion: 'INV-FW-1.0',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 30,
      },
    });
    hikChildId = hikChild.id;

    const lorexGateway = await prisma.device.create({
      data: {
        siteId: siteAId,
        name: 'Lorex Home Center',
        externalId: `LOREX-HC-${runId}`,
        deviceType: 'GATEWAY',
        monitoringMode: 'DIRECT',
        manufacturer: 'Lorex',
        model: 'Lorex Smart Home Security Center L871T8',
        ipAddress: '192.168.0.118',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 60,
      },
    });
    lorexGatewayId = lorexGateway.id;

    const lorexChild = await prisma.device.create({
      data: {
        siteId: siteAId,
        name: 'Lorex Camera 1',
        externalId: `LOREX-CAM-1-${runId}`,
        deviceType: 'CAMERA',
        monitoringMode: 'VIA_GATEWAY',
        gatewayDeviceId: lorexGatewayId,
        manufacturer: 'Lorex',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 60,
      },
    });
    lorexChildId = lorexChild.id;

    const door = await prisma.device.create({
      data: {
        siteId: siteAId,
        name: 'Porta',
        externalId: `PORTA-${runId}`,
        deviceType: 'SENSOR',
        monitoringMode: 'INVENTORY_ONLY',
        manufacturer: 'Generic',
        model: 'DoorContact-1',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 60,
      },
    });
    doorId = door.id;

    const foreignDevice = await prisma.device.create({
      data: {
        siteId: siteBId,
        name: 'Foreign Camera',
        externalId: `FOREIGN-${runId}`,
        deviceType: 'CAMERA',
        monitoringMode: 'DIRECT',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 60,
      },
    });
    foreignDeviceId = foreignDevice.id;

    adminToken = await login(adminEmail);

    recorderKey = (
      await request(app.getHttpServer())
        .post(`${API}/devices/${recorderId}/ingestion-key/rotate`)
        .set(bearer(adminToken))
        .expect(201)
    ).body.deviceKey;

    lorexKey = (
      await request(app.getHttpServer())
        .post(`${API}/devices/${lorexGatewayId}/ingestion-key/rotate`)
        .set(bearer(adminToken))
        .expect(201)
    ).body.deviceKey;
  });

  afterAll(async () => {
    const filter = { in: organizationIds };

    await prisma.auditLog.deleteMany({ where: { organizationId: filter } });
    await prisma.userSession.deleteMany({ where: { organizationId: filter } });
    await prisma.authChallenge.deleteMany({ where: { organizationId: filter } });
    await prisma.alert.deleteMany({
      where: { device: { site: { organizationId: filter } } },
    });
    await prisma.deviceConnectivityEvent.deleteMany({
      where: { device: { site: { organizationId: filter } } },
    });
    await prisma.edgeAgentRuntimeSnapshot.deleteMany({
      where: { device: { site: { organizationId: filter } } },
    });
    await prisma.recorderObservationSnapshot.deleteMany({
      where: { device: { site: { organizationId: filter } } },
    });
    await prisma.deviceTelemetrySnapshot.deleteMany({
      where: { device: { site: { organizationId: filter } } },
    });
    await prisma.deviceIngestionCredential.deleteMany({
      where: { device: { site: { organizationId: filter } } },
    });
    await prisma.device.deleteMany({
      where: { site: { organizationId: filter } },
    });
    await prisma.user.deleteMany({ where: { organizationId: filter } });
    await prisma.site.deleteMany({ where: { organizationId: filter } });
    await prisma.organization.deleteMany({ where: { id: filter } });

    await prisma.$disconnect();
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as LoginBody).accessToken;
  }

  function intelligence(deviceId: string, token = adminToken) {
    return request(app.getHttpServer())
      .get(`${API}/devices/${deviceId}/intelligence`)
      .set(bearer(token));
  }

  async function ingestRecorder(overrides: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .post(`${API}/telemetry/ingest`)
      .set('x-device-id', recorderId)
      .set('x-device-key', recorderKey)
      .send({
        timestamp: Math.floor(Date.now() / 1000),
        status: 'online',
        model: 'N8NRL',
        firmware: '1.0.0.0',
        collectionState: 'PARTIAL',
        collectionIssues: [
          {
            code: 'OPTIONAL_ENRICHMENT_UNAVAILABLE',
            source: 'ADAPTER',
            detail: 'cameraFirmware:c1: errorCode=536870962',
          },
        ],
        capabilities: {
          storage: { supported: true, present: false, state: 'NOT_INSTALLED' },
          recording: { state: 'NOT_AVAILABLE_NO_STORAGE' },
        },
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
        ...overrides,
      })
      .expect(201);
  }

  async function observeHik(
    status: 'online' | 'offline',
    observation: Record<string, unknown> = {},
  ) {
    return request(app.getHttpServer())
      .post(`${API}/telemetry/recorder-observations`)
      .set('x-device-id', recorderId)
      .set('x-device-key', recorderKey)
      .send({
        timestamp: Math.floor(Date.now() / 1000),
        observations: [
          {
            deviceId: hikChildId,
            status,
            channelId: '{00000001-0000-0000-0000-000000000000}',
            channelNumber: 1,
            poePort: 1,
            poePowerW: status === 'online' ? 3.2 : 0,
            protocol: 'ONVIF',
            recordingStatus: 'NOT_AVAILABLE_NO_STORAGE',
            bitrateKbps: 3072,
            resolution: '1920x1080',
            frameRate: 30,
            ...observation,
          },
        ],
      })
      .expect(201);
  }

  it('18. device that does not belong to the tenant -> 404 (no existence leak)', async () => {
    await intelligence(foreignDeviceId).expect(404);
    await intelligence(randomUUID()).expect(404);
    await request(app.getHttpServer())
      .get(`${API}/devices/not-a-uuid/intelligence`)
      .set(bearer(adminToken))
      .expect(400);
  });

  it('1/2/3/8/19. Speco NVR: ONLINE/HEALTHY without HDD, PoE + storage evidence with provenance', async () => {
    await ingestRecorder();

    const { body } = await intelligence(recorderId).expect(200);

    expect(body.device.deviceType).toBe('RECORDER');
    expect(body.connectivity.linkState).toBe('ONLINE');
    expect(body.connectivity.legacyState).toBe('ONLINE');
    expect(body.connectivity.freshness).toBe('FRESH');
    expect(body.health.state).toBe('HEALTHY');
    expect(body.health.reasons).toEqual([]);

    // collection quality is surfaced but never changes connectivity/health
    expect(body.collection.state).toBe('PARTIAL');
    expect(body.collection.issues.map((i: { code: string }) => i.code)).toEqual([
      'OPTIONAL_ENRICHMENT_UNAVAILABLE',
    ]);

    // storage NOT_INSTALLED is a capability state, not a fault
    expect(body.capabilities.storage.state).toBe('NOT_INSTALLED');
    expect(body.capabilities.storage.present).toBe(false);
    expect(body.capabilities.recording.state).toBe('NOT_AVAILABLE_NO_STORAGE');

    // identity provenance
    expect(body.identity.model).toMatchObject({
      value: 'N8NRL',
      source: 'ADAPTER',
      confidence: 'OBSERVED',
    });
    expect(body.identity.firmware).toMatchObject({
      value: '1.0.0.0',
      source: 'ADAPTER',
    });
    expect(body.identity.manufacturer).toMatchObject({
      value: 'Speco Technologies',
      source: 'INVENTORY',
      confidence: 'DECLARED',
    });
    expect(body.identity.hardwareVersion).toMatchObject({
      value: '1A',
      source: 'ADAPTER',
    });
    expect(body.identity.apiVersion.value).toBe('2.0');
    expect(body.identity.onvifVersion.value).toBe('18.12');
    expect(body.identity.serialNumber.value).toBeNull();
    expect(body.identity.serialNumber.source).toBeNull();

    // recorder host capacity view (PoE budget + channel counts)
    expect(body.recorderHost).toMatchObject({
      storageState: 'NOT_INSTALLED',
      storagePresent: false,
      diskCount: 0,
      poeTotalPowerW: 120,
      poeRemainingPowerW: 90.5,
      poeUsedPowerW: 29.5,
      observedChannelCount: 3,
      onlineChannelCount: 3,
    });
    expect(body.recorderChannel).toBeNull();

    // evidence is data-driven and carries provenance
    const bySubject = Object.fromEntries(
      body.evidence.map((e: { subject: string }) => [e.subject, e]),
    );
    expect(bySubject.connectivity).toMatchObject({
      value: 'ONLINE',
      source: 'ADAPTER',
      confidence: 'OBSERVED',
    });
    expect(bySubject.storage).toMatchObject({
      value: 'NOT_INSTALLED',
      detail: expect.stringContaining('not a fault'),
    });
    expect(bySubject.poeBudget).toMatchObject({
      value: 29.5,
      source: 'ADAPTER',
      detail: expect.stringContaining('120 W'),
    });
    expect(bySubject.collection).toMatchObject({
      value: 'OPTIONAL_ENRICHMENT_UNAVAILABLE',
    });

    expect(
      body.limitations.some((l: string) =>
        l.includes('mapped / expected channel count'),
      ),
    ).toBe(true);

    // no incident was opened for the recorder from collection quality
    const recorderIncident = await prisma.alert.findFirst({
      where: { deviceId: recorderId, status: 'OPEN' },
    });
    expect(recorderIncident).toBeNull();
  });

  it('1b. a reported COMPLETE with an optional enrichment gap projects as PARTIAL', async () => {
    await ingestRecorder({
      collectionState: 'COMPLETE',
      collectionIssues: [
        {
          code: 'OPTIONAL_ENRICHMENT_UNAVAILABLE',
          source: 'ADAPTER',
          detail: 'cameraFirmware:c1: errorCode=536870962',
        },
        {
          code: 'OPTIONAL_ENRICHMENT_UNAVAILABLE',
          source: 'ADAPTER',
          detail: 'cameraFirmware:c2: errorCode=536870962',
        },
        {
          code: 'OPTIONAL_ENRICHMENT_UNAVAILABLE',
          source: 'ADAPTER',
          detail: 'cameraFirmware:c3: errorCode=536870962',
        },
      ],
    });

    const { body } = await intelligence(recorderId).expect(200);

    expect(body.collection.state).toBe('PARTIAL');
    expect(
      body.collection.issues.map((i: { code: string }) => i.code),
    ).toEqual([
      'OPTIONAL_ENRICHMENT_UNAVAILABLE',
      'OPTIONAL_ENRICHMENT_UNAVAILABLE',
      'OPTIONAL_ENRICHMENT_UNAVAILABLE',
    ]);
    // core collection intact: recorder ONLINE/HEALTHY, no incident
    expect(body.connectivity.linkState).toBe('ONLINE');
    expect(body.health.state).toBe('HEALTHY');
    expect(body.health.reasons).toEqual([]);

    const recorderIncident = await prisma.alert.findFirst({
      where: { deviceId: recorderId, status: 'OPEN' },
    });
    expect(recorderIncident).toBeNull();
  });

  it('12/14. observation carries model but no firmware -> falls through to the declared inventory firmware', async () => {
    await ingestRecorder();
    // first and only observation so far: model, but the recorder returned no
    // firmware for this channel (queryIPChlInfo / vendor enrichment gap).
    await observeHik('online', { model: 'DS-2CD2123G0-I' });

    const { body } = await intelligence(hikChildId).expect(200);

    expect(body.identity.model).toMatchObject({
      value: 'DS-2CD2123G0-I',
      source: 'RECORDER',
      confidence: 'VERIFIED',
    });
    // observed firmware is absent -> the confident inventory value is kept,
    // never replaced with null.
    expect(body.identity.firmware).toMatchObject({
      value: 'INV-FW-1.0',
      source: 'INVENTORY',
      confidence: 'DECLARED',
    });
  });

  it('4/6/13/19. Hikvision recorder-verified online: model + firmware + channel from the recorder (VERIFIED)', async () => {
    await ingestRecorder();
    await observeHik('online', {
      model: 'DS-2CD2123G0-I',
      firmware: 'V5.5.82 build 190909',
    });

    const { body } = await intelligence(hikChildId).expect(200);

    expect(body.connectivity.linkState).toBe('ONLINE');
    expect(body.monitoring).toMatchObject({
      mode: 'VIA_GATEWAY',
      source: 'RECORDER_OBSERVED',
      verification: 'RECORDER_VERIFIED',
      observerDeviceId: recorderId,
      observerDeviceName: 'NVR Speco',
      channelNumber: 1,
      poePort: 1,
    });

    // observed identity beats the inventory value, tagged VERIFIED
    expect(body.identity.model).toMatchObject({
      value: 'DS-2CD2123G0-I',
      source: 'RECORDER',
      confidence: 'VERIFIED',
      observerDeviceId: recorderId,
    });
    expect(body.identity.firmware).toMatchObject({
      value: 'V5.5.82 build 190909',
      source: 'RECORDER',
      confidence: 'VERIFIED',
    });

    expect(body.recorderChannel).toMatchObject({
      observerDeviceName: 'NVR Speco',
      channelNumber: 1,
      poePort: 1,
      poePowerW: 3.2,
      bitrateKbps: 3072,
      frameRate: 30,
      resolution: '1920x1080',
      recordingState: 'NOT_AVAILABLE_NO_STORAGE',
    });
    expect(body.network.protocols).toEqual(['ONVIF']);
    expect(body.network.macAddress.value).toBeNull();

    const connectivityEvidence = body.evidence.find(
      (e: { subject: string }) => e.subject === 'connectivity',
    );
    expect(connectivityEvidence).toMatchObject({
      value: 'ONLINE',
      source: 'RECORDER',
      confidence: 'VERIFIED',
      observerDeviceName: 'NVR Speco',
      channelNumber: 1,
    });
    expect(
      body.evidence.some(
        (e: { subject: string; value: unknown }) =>
          e.subject === 'poePower' && e.value === 3.2,
      ),
    ).toBe(true);
    expect(body.freshness.state).toBe('FRESH');
  });

  it('5/11. Hikvision recorder-verified offline: OFFLINE + CRITICAL + STALE, honest reasons, then recovers', async () => {
    await ingestRecorder();
    await observeHik('online', { model: 'DS-2CD2123G0-I' });
    await observeHik('offline');

    const { body } = await intelligence(hikChildId).expect(200);

    expect(body.connectivity.linkState).toBe('OFFLINE');
    expect(body.connectivity.legacyState).toBe('OFFLINE');
    expect(body.health.state).toBe('CRITICAL');
    expect(body.connectivity.reasons).toEqual(
      expect.arrayContaining(['REPORTED_OFFLINE', 'RECORDER_VERIFIED_OFFLINE']),
    );
    expect(body.freshness.state).toBe('STALE');

    const offlineAlert = await prisma.alert.findFirst({
      where: {
        deviceId: hikChildId,
        status: 'OPEN',
        severity: 'CRITICAL',
        connectivityState: 'OFFLINE',
      },
    });
    expect(offlineAlert).not.toBeNull();

    // recover for the following tests
    await observeHik('online', { model: 'DS-2CD2123G0-I' });
    const recovered = await intelligence(hikChildId).expect(200);
    expect(recovered.body.connectivity.linkState).toBe('ONLINE');
  });

  it('7. firmware stays null and is flagged when nothing observed it and no inventory value exists', async () => {
    // Lorex child never receives a recorder observation and has no inventory firmware.
    const { body } = await intelligence(lorexChildId).expect(200);

    expect(body.connectivity.linkState).toBe('NEVER_SEEN');
    expect(body.identity.firmware.value).toBeNull();
    expect(body.identity.firmware.source).toBeNull();
    expect(body.identity.model.value).toBeNull();
    expect(body.evidence).toEqual([]);
    expect(
      body.limitations.some((l: string) =>
        l.toLowerCase().includes('firmware'),
      ),
    ).toBe(true);
    expect(
      body.limitations.some((l: string) =>
        l.includes('per-channel observation'),
      ),
    ).toBe(true);
  });

  it('15. Lorex Home Center: only the data the gateway/inventory really provide', async () => {
    await request(app.getHttpServer())
      .post(`${API}/telemetry/ingest`)
      .set('x-device-id', lorexGatewayId)
      .set('x-device-key', lorexKey)
      .send({
        timestamp: Math.floor(Date.now() / 1000),
        status: 'online',
        model: 'Lorex Smart Home Security Center L871T8',
        collectionState: 'COMPLETE',
      })
      .expect(201);

    const { body } = await intelligence(lorexGatewayId).expect(200);

    expect(body.device.deviceType).toBe('GATEWAY');
    expect(body.connectivity.linkState).toBe('ONLINE');
    expect(body.identity.manufacturer).toMatchObject({
      value: 'Lorex',
      source: 'INVENTORY',
      confidence: 'DECLARED',
    });
    expect(body.identity.model).toMatchObject({
      value: 'Lorex Smart Home Security Center L871T8',
      source: 'GATEWAY',
    });
    expect(body.identity.firmware.value).toBeNull();
    expect(body.network.ipAddress).toMatchObject({
      value: '192.168.0.118',
      source: 'INVENTORY',
      confidence: 'DECLARED',
    });
    expect(body.network.macAddress.value).toBeNull();
    expect(body.capabilities.storage.state).toBe('NOT_APPLICABLE');
    expect(body.capabilities.recording.state).toBe('NOT_APPLICABLE');
    expect(body.recorderChannel).toBeNull();
    expect(body.recorderHost).toBeNull();
    expect(body.collection.state).toBe('COMPLETE');
    expect(
      body.limitations.some((l: string) => l.includes('MAC address')),
    ).toBe(true);
  });

  it('16. Lorex child camera: no capability, identity or health invented', async () => {
    const { body } = await intelligence(lorexChildId).expect(200);

    expect(body.connectivity.linkState).toBe('NEVER_SEEN');
    expect(body.health.state).toBe('UNKNOWN');
    expect(body.collection.state).toBe('NOT_APPLICABLE');
    expect(body.capabilities.storage.state).toBe('NOT_APPLICABLE');
    expect(body.capabilities.recording.state).toBe('NOT_APPLICABLE');
    expect(body.recorderChannel).toBeNull();
    expect(body.freshness.state).toBe('UNKNOWN');
    expect(body.identity.model.value).toBeNull();
    expect(body.identity.firmware.value).toBeNull();
    expect(body.monitoring.observerDeviceName).toBeNull();
  });

  it('17. INVENTORY_ONLY sensor (Porta): inventory-only intelligence, no fabricated telemetry', async () => {
    const { body } = await intelligence(doorId).expect(200);

    expect(body.device.deviceType).toBe('SENSOR');
    expect(body.connectivity.linkState).toBeNull();
    expect(body.connectivity.legacyState).toBeNull();
    expect(body.health.state).toBeNull();
    expect(body.collection.state).toBeNull();
    expect(body.capabilities).toBeNull();
    expect(body.identity.manufacturer.value).toBe('Generic');
    expect(body.identity.model).toMatchObject({
      value: 'DoorContact-1',
      source: 'INVENTORY',
    });
    expect(body.freshness.state).toBe('UNKNOWN');
    expect(
      body.limitations.some((l: string) =>
        l.includes('does not collect live telemetry'),
      ),
    ).toBe(true);
  });

  it('20. the intelligence endpoint never modifies any data', async () => {
    await ingestRecorder();
    await observeHik('online', { model: 'DS-2CD2123G0-I' });

    const before = await snapshotState();
    await intelligence(recorderId).expect(200);
    await intelligence(hikChildId).expect(200);
    await intelligence(lorexGatewayId).expect(200);
    await intelligence(lorexChildId).expect(200);
    await intelligence(doorId).expect(200);
    const after = await snapshotState();

    expect(after).toEqual(before);
  });

  async function snapshotState() {
    const [devices, telemetry, observations, alerts, events] =
      await Promise.all([
        prisma.device.findMany({
          where: { site: { organizationId: organizationAId } },
          select: { id: true, updatedAt: true },
          orderBy: { id: 'asc' },
        }),
        prisma.deviceTelemetrySnapshot.findMany({
          where: { device: { site: { organizationId: organizationAId } } },
          select: { deviceId: true, updatedAt: true, observedAt: true },
          orderBy: { deviceId: 'asc' },
        }),
        prisma.recorderObservationSnapshot.findMany({
          where: { device: { site: { organizationId: organizationAId } } },
          select: { deviceId: true, updatedAt: true, observedAt: true },
          orderBy: { deviceId: 'asc' },
        }),
        prisma.alert.count({
          where: { device: { site: { organizationId: organizationAId } } },
        }),
        prisma.deviceConnectivityEvent.count({
          where: { device: { site: { organizationId: organizationAId } } },
        }),
      ]);

    return {
      devices: devices.map((d) => ({
        id: d.id,
        updatedAt: d.updatedAt.toISOString(),
      })),
      telemetry: telemetry.map((t) => ({
        deviceId: t.deviceId,
        updatedAt: t.updatedAt.toISOString(),
        observedAt: t.observedAt.toISOString(),
      })),
      observations: observations.map((o) => ({
        deviceId: o.deviceId,
        updatedAt: o.updatedAt.toISOString(),
        observedAt: o.observedAt.toISOString(),
      })),
      alerts,
      events,
    };
  }
});
