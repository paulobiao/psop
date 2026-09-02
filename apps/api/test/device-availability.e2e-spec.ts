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
const PASSWORD = 'DeviceAvailabilityPassword123!';
const HOUR = 3600 * 1000;

function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

interface EventSeed {
  at: Date;
  link: 'ONLINE' | 'OFFLINE' | 'UNKNOWN' | 'NEVER_SEEN';
  alias?: string;
  previousState?: string | null;
  eventType?: string;
  reasons?: string[];
  context?: Record<string, unknown>;
  lastHeartbeatAt?: Date | null;
  ageSeconds?: number | null;
}

describe('PSOP Operational History & Availability V1', () => {
  let app: INestApplication;

  const runId = randomUUID().slice(0, 8);
  const organizationIds: string[] = [];

  let orgAId: string;
  let orgBId: string;
  let siteAId: string;
  let siteBId: string;
  let adminToken: string;

  let directCamId: string;
  let openCamId: string;
  let unknownCamId: string;
  let recorderId: string;
  let childId: string;
  let sensorId: string;
  let foreignCamId: string;

  let openCamKey: string;

  const base = Date.now();
  const seededDeviceIds: string[] = [];

  async function seedEvents(deviceId: string, seeds: EventSeed[]) {
    seededDeviceIds.push(deviceId);
    await prisma.deviceConnectivityEvent.createMany({
      data: seeds.map((seed) => ({
        deviceId,
        eventType: seed.eventType ?? 'CONNECTIVITY_CHANGED',
        previousState:
          seed.previousState === undefined ? null : seed.previousState,
        currentState: seed.alias ?? seed.link,
        detectedAt: seed.at,
        lastHeartbeatAt: seed.lastHeartbeatAt ?? null,
        ageSeconds: seed.ageSeconds ?? null,
        context: {
          reasons: seed.reasons ?? [],
          monitoringSource: 'DIRECT',
          individualVerification: 'DIRECT',
          observerDeviceId: null,
          observerDeviceName: null,
          channelId: null,
          channelNumber: null,
          lastHeartbeatAt: seed.lastHeartbeatAt?.toISOString() ?? null,
          ageSeconds: seed.ageSeconds ?? null,
          linkState: seed.link,
          ...(seed.context ?? {}),
        },
      })),
    });
  }

  /**
   * Creates a fresh DIRECT camera under org A, seeds it with `events`, and
   * ingests stale telemetry so Health Engine V2 reports it OFFLINE right now.
   * Self-contained: every test that needs a "currently OFFLINE" device builds
   * its own, so nothing depends on another `it` or on file order.
   */
  async function createOfflineCamera(
    label: string,
    events: EventSeed[],
  ): Promise<string> {
    const device = await prisma.device.create({
      data: {
        siteId: siteAId,
        name: `Availability ${label}`,
        externalId: `AVAIL-${label}-${runId}`,
        deviceType: 'CAMERA',
        monitoringMode: 'DIRECT',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 60,
      },
    });

    const rotation = await request(app.getHttpServer())
      .post(`${API}/devices/${device.id}/ingestion-key/rotate`)
      .set(bearer(adminToken))
      .expect(201);

    await seedEvents(device.id, events);

    // Telemetry observed 10 min ago with a 60 s heartbeat interval -> stale ->
    // Health Engine V2 keeps connectivity.linkState = OFFLINE.
    await request(app.getHttpServer())
      .post(`${API}/telemetry/ingest`)
      .set('x-device-id', device.id)
      .set('x-device-key', rotation.body.deviceKey)
      .send({
        timestamp: Math.floor((Date.now() - 10 * 60 * 1000) / 1000),
        status: 'online',
      })
      .expect(201);

    return device.id;
  }

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password: PASSWORD })
      .expect(200);
    return response.body.accessToken;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'device-availability-access-secret-long-enough';
    process.env.JWT_REFRESH_SECRET =
      'device-availability-refresh-secret-long-enough';
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
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

    await app.init();
    await prisma.$connect();

    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: {
          name: `Availability A ${runId}`,
          slug: `availability-a-${runId}`,
        },
      }),
      prisma.organization.create({
        data: {
          name: `Availability B ${runId}`,
          slug: `availability-b-${runId}`,
        },
      }),
    ]);
    orgAId = orgA.id;
    orgBId = orgB.id;
    organizationIds.push(orgAId, orgBId);

    const [siteA, siteB] = await Promise.all([
      prisma.site.create({
        data: {
          organizationId: orgAId,
          name: 'Availability Site A',
          code: `AVAIL-A-${runId}`,
          timezone: 'America/New_York',
        },
      }),
      prisma.site.create({
        data: {
          organizationId: orgBId,
          name: 'Availability Site B',
          code: `AVAIL-B-${runId}`,
          timezone: 'America/New_York',
        },
      }),
    ]);
    siteAId = siteA.id;
    siteBId = siteB.id;

    const passwordHash = await hash(PASSWORD, 12);
    await prisma.user.create({
      data: {
        organizationId: orgAId,
        name: 'Availability Admin',
        email: `availability-admin-${runId}@psop.test`,
        passwordHash,
        role: 'ADMIN',
        mustChangePassword: false,
      },
    });

    const directCam = await prisma.device.create({
      data: {
        siteId: siteAId,
        name: 'Availability Direct Camera',
        externalId: `AVAIL-CAM-${runId}`,
        deviceType: 'CAMERA',
        monitoringMode: 'DIRECT',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 60,
      },
    });
    directCamId = directCam.id;

    const openCam = await prisma.device.create({
      data: {
        siteId: siteAId,
        name: 'Availability Open Outage Camera',
        externalId: `AVAIL-OPEN-${runId}`,
        deviceType: 'CAMERA',
        monitoringMode: 'DIRECT',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 60,
      },
    });
    openCamId = openCam.id;

    const unknownCam = await prisma.device.create({
      data: {
        siteId: siteAId,
        name: 'Availability Unknown-Close Camera',
        externalId: `AVAIL-UNK-${runId}`,
        deviceType: 'CAMERA',
        monitoringMode: 'DIRECT',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 60,
      },
    });
    unknownCamId = unknownCam.id;

    const recorder = await prisma.device.create({
      data: {
        siteId: siteAId,
        name: 'Availability NVR',
        externalId: `AVAIL-NVR-${runId}`,
        deviceType: 'RECORDER',
        monitoringMode: 'DIRECT',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 30,
      },
    });
    recorderId = recorder.id;

    const child = await prisma.device.create({
      data: {
        siteId: siteAId,
        name: 'Availability Recorder Child',
        externalId: `AVAIL-CHILD-${runId}`,
        deviceType: 'CAMERA',
        monitoringMode: 'VIA_GATEWAY',
        gatewayDeviceId: recorderId,
        status: 'ACTIVE',
        expectedHeartbeatInterval: 30,
      },
    });
    childId = child.id;

    const sensor = await prisma.device.create({
      data: {
        siteId: siteAId,
        name: 'Availability Door Sensor',
        externalId: `AVAIL-SENSOR-${runId}`,
        deviceType: 'SENSOR',
        monitoringMode: 'INVENTORY_ONLY',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 60,
      },
    });
    sensorId = sensor.id;

    const foreignCam = await prisma.device.create({
      data: {
        siteId: siteBId,
        name: 'Foreign Camera',
        externalId: `AVAIL-FOREIGN-${runId}`,
        deviceType: 'CAMERA',
        monitoringMode: 'DIRECT',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 60,
      },
    });
    foreignCamId = foreignCam.id;

    adminToken = await login(`availability-admin-${runId}@psop.test`);

    const rotation = await request(app.getHttpServer())
      .post(`${API}/devices/${openCamId}/ingestion-key/rotate`)
      .set(bearer(adminToken))
      .expect(201);
    openCamKey = rotation.body.deviceKey;
  });

  afterAll(async () => {
    await prisma.deviceConnectivityEvent.deleteMany({
      where: { device: { site: { organizationId: { in: organizationIds } } } },
    });
    await prisma.alert.deleteMany({
      where: { device: { site: { organizationId: { in: organizationIds } } } },
    });
    await prisma.deviceTelemetrySnapshot.deleteMany({
      where: { device: { site: { organizationId: { in: organizationIds } } } },
    });
    await prisma.recorderObservationSnapshot.deleteMany({
      where: { device: { site: { organizationId: { in: organizationIds } } } },
    });
    await prisma.edgeAgentRuntimeSnapshot.deleteMany({
      where: { device: { site: { organizationId: { in: organizationIds } } } },
    });
    await prisma.deviceIngestionCredential.deleteMany({
      where: { device: { site: { organizationId: { in: organizationIds } } } },
    });
    await prisma.device.deleteMany({
      where: { site: { organizationId: { in: organizationIds } } },
    });
    await prisma.userSession.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    await prisma.authChallenge.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    await prisma.auditLog.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    await prisma.user.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    await prisma.site.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    await prisma.organization.deleteMany({
      where: { id: { in: organizationIds } },
    });

    await app.close();
    await prisma.$disconnect();
  });

  // ---- auth / validation --------------------------------------------------

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .get(`${API}/devices/${directCamId}/availability`)
      .expect(401);
  });

  it('18. a device outside the caller org is a 404 (no existence leak)', async () => {
    await request(app.getHttpServer())
      .get(`${API}/devices/${foreignCamId}/availability`)
      .set(bearer(adminToken))
      .expect(404);
  });

  it('rejects a non-observable device with 400', async () => {
    await request(app.getHttpServer())
      .get(`${API}/devices/${sensorId}/availability`)
      .set(bearer(adminToken))
      .expect(400);
  });

  it('19. rejects an invalid device id and invalid query params', async () => {
    await request(app.getHttpServer())
      .get(`${API}/devices/not-a-uuid/availability`)
      .set(bearer(adminToken))
      .expect(400);

    await request(app.getHttpServer())
      .get(`${API}/devices/${directCamId}/availability`)
      .query({ window: 'forever' })
      .set(bearer(adminToken))
      .expect(400);

    await request(app.getHttpServer())
      .get(`${API}/devices/${directCamId}/availability`)
      .query({
        from: new Date(base).toISOString(),
        to: new Date(base - HOUR).toISOString(),
      })
      .set(bearer(adminToken))
      .expect(400);
  });

  it('resolves window presets', async () => {
    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${directCamId}/availability`)
      .query({ window: '7d' })
      .set(bearer(adminToken))
      .expect(200);

    expect(response.body.period.window).toBe('7d');
    expect(response.body.period.durationSeconds).toBeGreaterThanOrEqual(
      7 * 86400 - 10,
    );
    expect(response.body.deviceId).toBe(directCamId);
  });

  // ---- reconstruction ---------------------------------------------------

  it('1/2/4/20/21/22. reconstructs one closed outage with correct math', async () => {
    await seedEvents(directCamId, [
      { at: new Date(base - 11 * HOUR), link: 'ONLINE', eventType: 'INITIAL_STATE' },
      {
        at: new Date(base - 8 * HOUR),
        link: 'OFFLINE',
        previousState: 'ONLINE',
        reasons: ['HEARTBEAT_OVERDUE'],
        lastHeartbeatAt: new Date(base - 8 * HOUR - 90 * 1000),
      },
      { at: new Date(base - 6 * HOUR), link: 'ONLINE', previousState: 'OFFLINE' },
    ]);

    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${directCamId}/availability`)
      .query({
        from: new Date(base - 10 * HOUR).toISOString(),
        to: new Date(base - 1 * HOUR).toISOString(),
      })
      .set(bearer(adminToken))
      .expect(200);

    const body = response.body;
    expect(body.period.clampedToNow).toBe(false);
    expect(body.period.durationSeconds).toBe(9 * 3600);
    expect(body.coverage.hasAnchorBeforeWindow).toBe(true);

    expect(body.outages.count).toBe(1);
    expect(body.availability.uptimeSeconds).toBe(7 * 3600);
    expect(body.availability.downtimeSeconds).toBe(2 * 3600);
    expect(body.availability.unknownSeconds).toBe(0);
    expect(body.availability.confirmedObservedSeconds).toBe(9 * 3600);
    expect(body.availability.coveragePercentage).toBe(100);
    // full coverage -> period figure is a number
    expect(body.availability.percentage).toBeCloseTo((7 / 9) * 100, 3);
    expect(body.availability.confirmedAvailabilityPercentage).toBeCloseTo(
      (7 / 9) * 100,
      3,
    );
    expect(body.availability.unavailableReason).toBeNull();

    const interval = body.intervals[0];
    expect(interval.open).toBe(false);
    expect(interval.durationSeconds).toBe(2 * 3600);
    expect(interval.clipped).toEqual({ start: false, end: false });
    expect(interval.reasonCodes).toEqual(['HEARTBEAT_OVERDUE']);
    expect(interval.detectionLatencySeconds).toBe(90);
    expect(interval.endedByState).toBe('ONLINE');
    expect(interval.recoveryConfirmed).toBe(true);
    expect(interval.recoveryReasonCodes).toEqual([]);

    expect(body.outages.longestSeconds).toBe(2 * 3600);
    expect(body.outages.lastOutageAt).toBe(
      new Date(base - 8 * HOUR).toISOString(),
    );
    expect(body.outages.lastRecoveryAt).toBe(
      new Date(base - 6 * HOUR).toISOString(),
    );
    expect(body.current.outageOpen).toBe(false);
  });

  it('4. an outage that started before the window is clipped, not lost', async () => {
    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${directCamId}/availability`)
      .query({
        // window opens in the middle of the seeded outage
        from: new Date(base - 7 * HOUR).toISOString(),
        to: new Date(base - 1 * HOUR).toISOString(),
      })
      .set(bearer(adminToken))
      .expect(200);

    const interval = response.body.intervals[0];
    expect(interval.clipped.start).toBe(true);
    expect(interval.startedAt).toBe(new Date(base - 7 * HOUR).toISOString());
    expect(interval.actualStartedAt).toBe(
      new Date(base - 8 * HOUR).toISOString(),
    );
    expect(interval.durationSeconds).toBe(1 * 3600);
    expect(interval.actualDurationSeconds).toBe(2 * 3600);
  });

  it('7. zero events and no anchor -> NO_HISTORY, percentage null', async () => {
    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${childId}/availability`)
      .query({ window: '24h' })
      .set(bearer(adminToken))
      .expect(200);

    expect(response.body.availability.percentage).toBeNull();
    expect(response.body.availability.confirmedAvailabilityPercentage).toBeNull();
    expect(response.body.availability.unavailableReason).toBe('NO_HISTORY');
    expect(response.body.outages.count).toBe(0);
    expect(response.body.coverage.eventCount).toBe(0);
  });

  it('9/10. UNKNOWN time is surfaced separately and excluded from uptime', async () => {
    await seedEvents(recorderId, [
      { at: new Date(base - 9 * HOUR), link: 'ONLINE', eventType: 'INITIAL_STATE' },
      {
        at: new Date(base - 6 * HOUR),
        link: 'UNKNOWN',
        alias: 'UNKNOWN',
        previousState: 'ONLINE',
        reasons: ['STALE_OBSERVATION'],
      },
      { at: new Date(base - 4 * HOUR), link: 'ONLINE', previousState: 'UNKNOWN' },
    ]);

    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${recorderId}/availability`)
      .query({
        from: new Date(base - 8 * HOUR).toISOString(),
        to: new Date(base - 1 * HOUR).toISOString(),
      })
      .set(bearer(adminToken))
      .expect(200);

    const body = response.body;
    expect(body.availability.unknownSeconds).toBe(2 * 3600);
    expect(body.availability.downtimeSeconds).toBe(0);
    expect(body.availability.uptimeSeconds).toBe(5 * 3600);
    // a coverage gap -> no period-level figure, but a confirmed-time figure
    expect(body.availability.percentage).toBeNull();
    expect(body.availability.unavailableReason).toBe('INCOMPLETE_COVERAGE');
    expect(body.availability.confirmedAvailabilityPercentage).toBe(100);
    expect(body.availability.coveragePercentage).toBeCloseTo((5 / 7) * 100, 3);
    expect(body.outages.count).toBe(0);
    expect(
      body.limitations.some((line: string) => line.includes('UNKNOWN')),
    ).toBe(true);
  });

  it('2b. OFFLINE -> UNKNOWN ends confirmed downtime but is not a recovery', async () => {
    await seedEvents(unknownCamId, [
      { at: new Date(base - 8 * HOUR), link: 'ONLINE', eventType: 'INITIAL_STATE' },
      {
        at: new Date(base - 6 * HOUR),
        link: 'OFFLINE',
        previousState: 'ONLINE',
        reasons: ['HEARTBEAT_OVERDUE'],
      },
      {
        at: new Date(base - 5 * HOUR),
        link: 'UNKNOWN',
        alias: 'UNKNOWN',
        previousState: 'OFFLINE',
        reasons: ['STALE_OBSERVATION'],
      },
      { at: new Date(base - 3 * HOUR), link: 'ONLINE', previousState: 'UNKNOWN' },
    ]);

    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${unknownCamId}/availability`)
      .query({
        from: new Date(base - 7 * HOUR).toISOString(),
        to: new Date(base - 1 * HOUR).toISOString(),
      })
      .set(bearer(adminToken))
      .expect(200);

    const body = response.body;
    const offline = body.intervals[0];
    // confirmed downtime stopped at the UNKNOWN boundary (6h..5h = 1h)
    expect(offline.durationSeconds).toBe(1 * 3600);
    expect(offline.endedAt).toBe(new Date(base - 5 * HOUR).toISOString());
    expect(offline.endedByState).toBe('UNKNOWN');
    expect(offline.recoveryConfirmed).toBe(false);
    expect(offline.recoveryReasonCodes).toBeNull();
    // the later UNKNOWN -> ONLINE is NOT a recovery of any outage
    expect(body.outages.lastRecoveryAt).toBeNull();
    expect(body.availability.downtimeSeconds).toBe(1 * 3600);
    expect(body.availability.unknownSeconds).toBe(2 * 3600);
    expect(body.availability.percentage).toBeNull();
    expect(body.availability.unavailableReason).toBe('INCOMPLETE_COVERAGE');
  });

  it('11/12. DEGRADED alias / health degradation never becomes downtime', async () => {
    await seedEvents(childId, [
      { at: new Date(base - 5 * HOUR), link: 'ONLINE', eventType: 'INITIAL_STATE' },
      {
        at: new Date(base - 3 * HOUR),
        link: 'ONLINE',
        alias: 'DEGRADED',
        previousState: 'ONLINE',
        reasons: ['HIGH_TEMPERATURE'],
        context: { linkState: 'ONLINE' },
      },
      { at: new Date(base - 2 * HOUR), link: 'ONLINE', alias: 'ONLINE' },
    ]);

    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${childId}/availability`)
      .query({
        from: new Date(base - 4 * HOUR).toISOString(),
        to: new Date(base - 1 * HOUR).toISOString(),
      })
      .set(bearer(adminToken))
      .expect(200);

    expect(response.body.outages.count).toBe(0);
    expect(response.body.availability.downtimeSeconds).toBe(0);
    expect(response.body.availability.uptimeSeconds).toBe(3 * 3600);
    expect(response.body.availability.percentage).toBe(100);
  });

  it('13/10b. recorder-verified child OFFLINE is a real outage with recorder evidence', async () => {
    await seedEvents(childId, [
      {
        at: new Date(base - 50 * 60 * 1000),
        link: 'OFFLINE',
        previousState: 'ONLINE',
        reasons: ['REPORTED_OFFLINE', 'RECORDER_VERIFIED_OFFLINE'],
        ageSeconds: 0,
        context: {
          monitoringSource: 'RECORDER_OBSERVED',
          individualVerification: 'RECORDER_VERIFIED',
          observerDeviceId: recorderId,
          observerDeviceName: 'Availability NVR',
          channelNumber: 1,
          linkState: 'OFFLINE',
        },
      },
      {
        at: new Date(base - 20 * 60 * 1000),
        link: 'ONLINE',
        previousState: 'OFFLINE',
        context: {
          monitoringSource: 'RECORDER_OBSERVED',
          individualVerification: 'RECORDER_VERIFIED',
          observerDeviceId: recorderId,
          linkState: 'ONLINE',
        },
      },
    ]);

    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${childId}/availability`)
      .query({ window: '24h' })
      .set(bearer(adminToken))
      .expect(200);

    const interval = response.body.intervals.find(
      (candidate: { reasonCodes: string[] }) =>
        candidate.reasonCodes.includes('RECORDER_VERIFIED_OFFLINE'),
    );
    expect(interval).toBeDefined();
    expect(interval.durationSeconds).toBe(30 * 60);
    expect(interval.monitoringSource).toBe('RECORDER_OBSERVED');
    expect(interval.individualVerification).toBe('RECORDER_VERIFIED');
    expect(interval.observerDeviceName).toBe('Availability NVR');
    expect(interval.channelNumber).toBe(1);
    expect(interval.detectionLatencySeconds).toBe(0);
  });

  it('14. a child outage never appears in the recorder’s own availability', async () => {
    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${recorderId}/availability`)
      .query({ window: '24h' })
      .set(bearer(adminToken))
      .expect(200);

    // The recorder's timeline only carries its own ONLINE/UNKNOWN/ONLINE events.
    expect(
      response.body.intervals.every(
        (interval: { reasonCodes: string[] }) =>
          !interval.reasonCodes.includes('RECORDER_VERIFIED_OFFLINE'),
      ),
    ).toBe(true);
    expect(response.body.deviceId).toBe(recorderId);
  });

  it('6/9c/23. an outage still open "now" is reported open with the real start', async () => {
    // A real transition recorded two hours ago...
    await seedEvents(openCamId, [
      {
        at: new Date(base - 2 * HOUR),
        link: 'OFFLINE',
        previousState: 'ONLINE',
        eventType: 'INITIAL_STATE',
        reasons: ['HEARTBEAT_OVERDUE'],
        lastHeartbeatAt: new Date(base - 2 * HOUR - 120 * 1000),
      },
    ]);

    // ...and telemetry that is still stale now -> Health Engine V2 keeps it OFFLINE.
    await request(app.getHttpServer())
      .post(`${API}/telemetry/ingest`)
      .set('x-device-id', openCamId)
      .set('x-device-key', openCamKey)
      .send({
        timestamp: Math.floor((base - 10 * 60 * 1000) / 1000),
        status: 'online',
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${openCamId}/availability`)
      .query({ window: '24h' })
      .set(bearer(adminToken))
      .expect(200);

    const body = response.body;
    expect(body.current.linkState).toBe('OFFLINE');
    expect(body.current.outageOpen).toBe(true);
    expect(body.current.outageStartedWithinWindow).toBe(true);
    expect(typeof body.current.outageStartedAt).toBe('string');

    const open = body.outages.openOutage;
    expect(open).not.toBeNull();
    expect(open.open).toBe(true);
    expect(open.endedAt).toBeNull();
    expect(open.clipped.end).toBe(true);
    expect(open.clipped.start).toBe(false);
    expect(open.recoveryConfirmed).toBe(false);
    expect(open.endedByState).toBeNull();
    expect(open.actualStartedAt).toBe(new Date(base - 2 * HOUR).toISOString());
    expect(
      Math.abs(open.durationSeconds - 2 * 3600),
    ).toBeLessThanOrEqual(5);
    expect(body.intervals.filter((i: { open: boolean }) => i.open)).toHaveLength(
      1,
    );
    // uptime is 0 over confirmed time -> confirmed availability is 0%, but the
    // period has a NO_DATA gap so the period-level figure is null.
    expect(body.availability.confirmedAvailabilityPercentage).toBe(0);
    expect(body.availability.percentage).toBeNull();
    expect(body.availability.unavailableReason).toBe('INCOMPLETE_COVERAGE');
    expect(body.availability.noDataSeconds).toBeGreaterThan(0);
  });

  it('25. historical window before current outage -> current.* still reconstructs the start', async () => {
    // Self-contained: this test builds its own currently-OFFLINE device.
    const bOff = Date.now() - 2 * HOUR;
    const deviceId = await createOfflineCamera('POSTWIN', [
      {
        at: new Date(bOff),
        link: 'OFFLINE',
        previousState: 'ONLINE',
        eventType: 'INITIAL_STATE',
        reasons: ['HEARTBEAT_OVERDUE'],
        lastHeartbeatAt: new Date(bOff - 120 * 1000),
      },
    ]);

    // Purely historical window that closes BEFORE the outage transition.
    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${deviceId}/availability`)
      .query({
        from: new Date(bOff - 6 * HOUR).toISOString(),
        to: new Date(bOff - 1 * HOUR).toISOString(),
      })
      .set(bearer(adminToken))
      .expect(200);

    const body = response.body;

    // historical reconstruction sees nothing in or before the window
    expect(body.period.clampedToNow).toBe(false);
    expect(body.availability.downtimeSeconds).toBe(0);
    expect(body.outages.count).toBe(0);

    // current.* is the live device state, independent of from/to
    expect(body.current.linkState).toBe('OFFLINE');
    expect(body.current.outageOpen).toBe(true);
    expect(body.current.outageStartedAt).toBe(new Date(bOff).toISOString());
    expect(body.current.outageStartedWithinWindow).toBe(false);
    expect(
      body.limitations.some((line: string) =>
        line.includes('after the end of the requested window'),
      ),
    ).toBe(true);
    // never the false "no connectivity transition has been recorded" claim
    expect(JSON.stringify(body)).not.toContain(
      'no connectivity transition has been recorded',
    );
  });

  it('26. historical outage A (open at `to`) + recovery + current outage B -> current points at B', async () => {
    // Self-contained. Live history:
    //   now-6h OFFLINE (A)  ->  now-5h ONLINE (recovery A)  ->  now-1h OFFLINE (B)
    const now = Date.now();
    const aOff = now - 6 * HOUR;
    const aOn = now - 5 * HOUR;
    const bOff = now - 1 * HOUR;

    const deviceId = await createOfflineCamera('AB', [
      {
        at: new Date(aOff),
        link: 'OFFLINE',
        previousState: 'ONLINE',
        reasons: ['HEARTBEAT_OVERDUE'],
      },
      { at: new Date(aOn), link: 'ONLINE', previousState: 'OFFLINE' },
      {
        at: new Date(bOff),
        link: 'OFFLINE',
        previousState: 'ONLINE',
        reasons: ['HEARTBEAT_OVERDUE'],
      },
    ]);

    // Window closes while A is still OFFLINE (before the recovery and before B).
    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${deviceId}/availability`)
      .query({
        from: new Date(now - 8 * HOUR).toISOString(),
        to: new Date(now - 5.5 * HOUR).toISOString(),
      })
      .set(bearer(adminToken))
      .expect(200);

    const body = response.body;

    // historical side: outage A only, clipped at `to`
    expect(body.period.clampedToNow).toBe(false);
    expect(body.outages.count).toBe(1);
    expect(body.intervals[0].actualStartedAt).toBe(new Date(aOff).toISOString());
    expect(body.intervals[0].clipped.end).toBe(true);

    // current side: outage B, never outage A
    expect(body.current.linkState).toBe('OFFLINE');
    expect(body.current.outageOpen).toBe(true);
    expect(body.current.outageStartedAt).toBe(new Date(bOff).toISOString());
    expect(body.current.outageStartedAt).not.toBe(new Date(aOff).toISOString());
    expect(body.current.outageStartedWithinWindow).toBe(false);
  });

  it('24. the endpoint never mutates state', async () => {
    const query = { window: '24h' as const };

    const before = await prisma.deviceConnectivityEvent.count({
      where: { deviceId: directCamId },
    });
    const snapshotBefore = await prisma.deviceTelemetrySnapshot.findUnique({
      where: { deviceId: directCamId },
    });

    await request(app.getHttpServer())
      .get(`${API}/devices/${directCamId}/availability`)
      .query(query)
      .set(bearer(adminToken))
      .expect(200);

    await request(app.getHttpServer())
      .get(`${API}/devices/${directCamId}/availability`)
      .query(query)
      .set(bearer(adminToken))
      .expect(200);

    const after = await prisma.deviceConnectivityEvent.count({
      where: { deviceId: directCamId },
    });
    const snapshotAfter = await prisma.deviceTelemetrySnapshot.findUnique({
      where: { deviceId: directCamId },
    });

    expect(after).toBe(before);
    expect(snapshotAfter).toEqual(snapshotBefore);
  });
});
