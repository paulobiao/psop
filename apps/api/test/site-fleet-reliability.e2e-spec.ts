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
const PASSWORD = 'SiteFleetReliabilityPassword123!';
const HOUR = 3600 * 1000;

function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

interface EventSeed {
  at: Date;
  link: 'ONLINE' | 'OFFLINE' | 'UNKNOWN' | 'NEVER_SEEN';
  previousState?: string | null;
  eventType?: string;
  reasons?: string[];
  context?: Record<string, unknown>;
}

describe('PSOP Site & Fleet Reliability V1', () => {
  let app: INestApplication;

  const runId = randomUUID().slice(0, 8);
  const organizationIds: string[] = [];

  let orgAId: string;
  let orgBId: string;
  let siteMainId: string; // org A — fully covered mix
  let siteSoloId: string; // org A — single device, 100%
  let siteEmptyId: string; // org A — no devices at all
  let siteGapId: string; // org A — a device with no history
  let siteForeignId: string; // org B

  let adminToken: string;

  let camOnlineId: string;
  let camOutageId: string;
  let nvrId: string;
  let childOnlineId: string;
  let childDownId: string;
  let degradedCamId: string;
  let sensorId: string;
  let soloCamId: string;
  let neverCamId: string;
  let foreignCamId: string;

  const base = Date.now();

  async function seedEvents(deviceId: string, seeds: EventSeed[]) {
    await prisma.deviceConnectivityEvent.createMany({
      data: seeds.map((seed) => ({
        deviceId,
        eventType: seed.eventType ?? 'CONNECTIVITY_CHANGED',
        previousState:
          seed.previousState === undefined ? null : seed.previousState,
        currentState: seed.link,
        detectedAt: seed.at,
        context: {
          reasons: seed.reasons ?? [],
          monitoringSource: 'DIRECT',
          individualVerification: 'DIRECT',
          observerDeviceId: null,
          observerDeviceName: null,
          channelId: null,
          channelNumber: null,
          lastHeartbeatAt: null,
          ageSeconds: null,
          linkState: seed.link,
          ...(seed.context ?? {}),
        },
      })),
    });
  }

  async function directTelemetry(
    deviceId: string,
    siteId: string,
    opts: { agoSeconds: number; status: string; temperatureC?: number },
  ) {
    const observedAt = new Date(Date.now() - opts.agoSeconds * 1000);
    await prisma.deviceTelemetrySnapshot.create({
      data: {
        deviceId,
        observedAt,
        reportedStatus: opts.status,
        temperatureC: opts.temperatureC ?? null,
      },
    });
  }

  async function recorderObservation(
    childId: string,
    recorderId: string,
    opts: { agoSeconds: number; status: string },
  ) {
    const observedAt = new Date(Date.now() - opts.agoSeconds * 1000);
    await prisma.recorderObservationSnapshot.create({
      data: {
        deviceId: childId,
        recorderDeviceId: recorderId,
        observedAt,
        reportedStatus: opts.status,
        channelNumber: 1,
      },
    });
  }

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password: PASSWORD })
      .expect(200);
    return response.body.accessToken;
  }

  function siteReliability(siteId: string, token = adminToken) {
    return request(app.getHttpServer())
      .get(`${API}/sites/${siteId}/reliability`)
      .set(bearer(token));
  }

  function fleetReliability(token = adminToken) {
    return request(app.getHttpServer())
      .get(`${API}/fleet/reliability`)
      .set(bearer(token));
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'site-fleet-reliability-access-secret-long-enough';
    process.env.JWT_REFRESH_SECRET =
      'site-fleet-reliability-refresh-secret-long-enough';
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

    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: {
          name: `Reliability A ${runId}`,
          slug: `reliability-a-${runId}`,
        },
      }),
      prisma.organization.create({
        data: {
          name: `Reliability B ${runId}`,
          slug: `reliability-b-${runId}`,
        },
      }),
    ]);
    orgAId = orgA.id;
    orgBId = orgB.id;
    organizationIds.push(orgAId, orgBId);

    const [siteMain, siteSolo, siteEmpty, siteGap, siteForeign] =
      await Promise.all([
        prisma.site.create({
          data: {
            organizationId: orgAId,
            name: 'Main Site',
            code: `MAIN-${runId}`,
            timezone: 'America/New_York',
          },
        }),
        prisma.site.create({
          data: {
            organizationId: orgAId,
            name: 'Solo Site',
            code: `SOLO-${runId}`,
          },
        }),
        prisma.site.create({
          data: {
            organizationId: orgAId,
            name: 'Empty Site',
            code: `EMPTY-${runId}`,
          },
        }),
        prisma.site.create({
          data: {
            organizationId: orgAId,
            name: 'Gap Site',
            code: `GAP-${runId}`,
          },
        }),
        prisma.site.create({
          data: {
            organizationId: orgBId,
            name: 'Foreign Site',
            code: `FOREIGN-${runId}`,
          },
        }),
      ]);
    siteMainId = siteMain.id;
    siteSoloId = siteSolo.id;
    siteEmptyId = siteEmpty.id;
    siteGapId = siteGap.id;
    siteForeignId = siteForeign.id;

    const passwordHash = await hash(PASSWORD, 12);
    await prisma.user.create({
      data: {
        organizationId: orgAId,
        name: 'Reliability Admin',
        email: `reliability-admin-${runId}@psop.test`,
        passwordHash,
        role: 'ADMIN',
        mustChangePassword: false,
      },
    });

    const mk = async (data: {
      siteId: string;
      name: string;
      externalId: string;
      deviceType?: 'CAMERA' | 'RECORDER' | 'GATEWAY' | 'SENSOR';
      monitoringMode?: 'DIRECT' | 'VIA_GATEWAY' | 'INVENTORY_ONLY';
      gatewayDeviceId?: string;
      expectedHeartbeatInterval?: number;
    }) => {
      const device = await prisma.device.create({
        data: {
          siteId: data.siteId,
          name: data.name,
          externalId: `${data.externalId}-${runId}`,
          deviceType: data.deviceType ?? 'CAMERA',
          monitoringMode: data.monitoringMode ?? 'DIRECT',
          gatewayDeviceId: data.gatewayDeviceId ?? null,
          status: 'ACTIVE',
          expectedHeartbeatInterval: data.expectedHeartbeatInterval ?? 60,
        },
      });
      return device.id;
    };

    camOnlineId = await mk({
      siteId: siteMainId,
      name: 'Cam Online',
      externalId: 'CAM-ONLINE',
    });
    camOutageId = await mk({
      siteId: siteMainId,
      name: 'Cam Outage',
      externalId: 'CAM-OUTAGE',
    });
    nvrId = await mk({
      siteId: siteMainId,
      name: 'Main NVR',
      externalId: 'NVR',
      deviceType: 'RECORDER',
      expectedHeartbeatInterval: 30,
    });
    childOnlineId = await mk({
      siteId: siteMainId,
      name: 'Child Online',
      externalId: 'CHILD-ONLINE',
      deviceType: 'CAMERA',
      monitoringMode: 'VIA_GATEWAY',
      gatewayDeviceId: nvrId,
      expectedHeartbeatInterval: 30,
    });
    childDownId = await mk({
      siteId: siteMainId,
      name: 'Child Down',
      externalId: 'CHILD-DOWN',
      deviceType: 'CAMERA',
      monitoringMode: 'VIA_GATEWAY',
      gatewayDeviceId: nvrId,
      expectedHeartbeatInterval: 30,
    });
    degradedCamId = await mk({
      siteId: siteMainId,
      name: 'Degraded Cam',
      externalId: 'CAM-DEGRADED',
    });
    sensorId = await mk({
      siteId: siteMainId,
      name: 'Door Sensor',
      externalId: 'SENSOR',
      deviceType: 'SENSOR',
      monitoringMode: 'INVENTORY_ONLY',
    });

    soloCamId = await mk({
      siteId: siteSoloId,
      name: 'Solo Cam',
      externalId: 'SOLO-CAM',
    });
    neverCamId = await mk({
      siteId: siteGapId,
      name: 'Never Cam',
      externalId: 'NEVER-CAM',
    });
    foreignCamId = await mk({
      siteId: siteForeignId,
      name: 'Foreign Cam',
      externalId: 'FOREIGN-CAM',
    });

    // ---- current state + history -----------------------------------------
    // Main site: everything currently reachable, full 30d coverage.
    const anchor = new Date(base - 30 * 24 * HOUR);

    await directTelemetry(camOnlineId, siteMainId, {
      agoSeconds: 30,
      status: 'online',
    });
    await seedEvents(camOnlineId, [
      { at: anchor, link: 'ONLINE', eventType: 'INITIAL_STATE' },
    ]);

    // Cam Outage: currently ONLINE, but a 2h closed outage inside the last 24h.
    await directTelemetry(camOutageId, siteMainId, {
      agoSeconds: 30,
      status: 'online',
    });
    await seedEvents(camOutageId, [
      { at: anchor, link: 'ONLINE', eventType: 'INITIAL_STATE' },
      {
        at: new Date(base - 6 * HOUR),
        link: 'OFFLINE',
        previousState: 'ONLINE',
        reasons: ['HEARTBEAT_OVERDUE'],
      },
      {
        at: new Date(base - 4 * HOUR),
        link: 'ONLINE',
        previousState: 'OFFLINE',
      },
    ]);

    await directTelemetry(nvrId, siteMainId, {
      agoSeconds: 15,
      status: 'online',
    });
    await seedEvents(nvrId, [
      { at: anchor, link: 'ONLINE', eventType: 'INITIAL_STATE' },
    ]);

    await recorderObservation(childOnlineId, nvrId, {
      agoSeconds: 15,
      status: 'online',
    });
    await seedEvents(childOnlineId, [
      { at: anchor, link: 'ONLINE', eventType: 'INITIAL_STATE' },
    ]);

    // Child Down: recorder currently reports the channel offline (authoritative) so
    // it is OFFLINE in `current`; history carries a 3h CLOSED outage in the window.
    await recorderObservation(childDownId, nvrId, {
      agoSeconds: 15,
      status: 'offline',
    });
    await seedEvents(childDownId, [
      { at: anchor, link: 'ONLINE', eventType: 'INITIAL_STATE' },
      {
        at: new Date(base - 8 * HOUR),
        link: 'OFFLINE',
        previousState: 'ONLINE',
        reasons: ['RECORDER_VERIFIED_OFFLINE'],
      },
      {
        at: new Date(base - 5 * HOUR),
        link: 'ONLINE',
        previousState: 'OFFLINE',
      },
    ]);

    // Degraded Cam: link ONLINE, health DEGRADED (hot). No downtime.
    await directTelemetry(degradedCamId, siteMainId, {
      agoSeconds: 30,
      status: 'online',
      temperatureC: 88,
    });
    await seedEvents(degradedCamId, [
      { at: anchor, link: 'ONLINE', eventType: 'INITIAL_STATE' },
    ]);

    // Solo site: one camera, always up, full coverage.
    await directTelemetry(soloCamId, siteSoloId, {
      agoSeconds: 30,
      status: 'online',
    });
    await seedEvents(soloCamId, [
      { at: anchor, link: 'ONLINE', eventType: 'INITIAL_STATE' },
    ]);

    // Gap site: never-seen camera, no telemetry, no events.

    adminToken = await login(`reliability-admin-${runId}@psop.test`);
  });

  afterAll(async () => {
    const filter = { in: organizationIds };
    await prisma.deviceConnectivityEvent.deleteMany({
      where: { device: { site: { organizationId: filter } } },
    });
    await prisma.alert.deleteMany({
      where: { device: { site: { organizationId: filter } } },
    });
    await prisma.deviceTelemetrySnapshot.deleteMany({
      where: { device: { site: { organizationId: filter } } },
    });
    await prisma.recorderObservationSnapshot.deleteMany({
      where: { device: { site: { organizationId: filter } } },
    });
    await prisma.deviceIngestionCredential.deleteMany({
      where: { device: { site: { organizationId: filter } } },
    });
    await prisma.device.deleteMany({
      where: { site: { organizationId: filter } },
    });
    await prisma.userSession.deleteMany({ where: { organizationId: filter } });
    await prisma.authChallenge.deleteMany({
      where: { organizationId: filter },
    });
    await prisma.auditLog.deleteMany({ where: { organizationId: filter } });
    await prisma.user.deleteMany({ where: { organizationId: filter } });
    await prisma.site.deleteMany({ where: { organizationId: filter } });
    await prisma.organization.deleteMany({ where: { id: filter } });

    await app.close();
    await prisma.$disconnect();
  });

  // ---- auth / tenant isolation -------------------------------------------

  it('requires authentication for both endpoints', async () => {
    await request(app.getHttpServer())
      .get(`${API}/sites/${siteMainId}/reliability`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`${API}/fleet/reliability`)
      .expect(401);
  });

  it('22/24. a site in another organization is a 404 (no existence leak)', async () => {
    await siteReliability(siteForeignId).expect(404);
  });

  it('24. an unknown / malformed site id is handled', async () => {
    await siteReliability(randomUUID()).expect(404);
    await request(app.getHttpServer())
      .get(`${API}/sites/not-a-uuid/reliability`)
      .set(bearer(adminToken))
      .expect(400);
  });

  it('23. fleet only ever consolidates the caller organization', async () => {
    const response = await fleetReliability().expect(200);

    expect(response.body.organizationId).toBe(orgAId);
    // 4 org-A sites; the foreign site never appears
    expect(response.body.population.sites).toBe(4);
    const siteIds = response.body.sites.map(
      (s: { siteId: string }) => s.siteId,
    );
    expect(siteIds).not.toContain(siteForeignId);
    expect(siteIds).toContain(siteMainId);

    const bodyText = JSON.stringify(response.body);
    expect(bodyText).not.toContain('Foreign Cam');
    expect(bodyText).not.toContain(foreignCamId);
  });

  // ---- period semantics -------------------------------------------------

  it('30/31. supports window presets and explicit from/to, rejects bad input', async () => {
    for (const window of ['24h', '7d', '30d']) {
      const response = await siteReliability(siteMainId)
        .query({ window })
        .expect(200);
      expect(response.body.period.window).toBe(window);
    }

    const explicit = await siteReliability(siteMainId)
      .query({
        from: new Date(base - 12 * HOUR).toISOString(),
        to: new Date(base - 2 * HOUR).toISOString(),
      })
      .expect(200);
    expect(explicit.body.period.window).toBeNull();
    expect(explicit.body.period.durationSeconds).toBe(10 * 3600);

    await siteReliability(siteMainId).query({ window: 'forever' }).expect(400);
    await siteReliability(siteMainId)
      .query({
        from: new Date(base).toISOString(),
        to: new Date(base - HOUR).toISOString(),
      })
      .expect(400);

    await fleetReliability().query({ window: '7d' }).expect(200);
  });

  // ---- site scope -----------------------------------------------------

  it('1/9/14/34. main site: mixed device types, full coverage -> percentage is a number; current from Health Engine, not history', async () => {
    const response = await siteReliability(siteMainId)
      .query({ window: '24h' })
      .expect(200);
    const body = response.body;

    // population: 6 eligible (sensor excluded)
    expect(body.population.eligibleDevices).toBe(6);
    expect(body.population.excludedDevices).toBe(1);
    expect(body.population.excludedByReason).toEqual({ INVENTORY_ONLY: 1 });

    // current: 5 online (incl. degraded cam), 1 offline (child down), independent
    // of the historical outages on Cam Outage / Child Down which are closed and
    // whose devices are ONLINE / OFFLINE right now for their own live reasons.
    expect(body.current).toEqual({
      online: 5,
      offline: 1,
      unknown: 0,
      neverSeen: 0,
    });

    // 6 devices * 24h, minus 2h (cam outage) + 3h (child down) closed downtime.
    const day = 24 * 3600;
    expect(body.aggregateAvailability.expectedDeviceSeconds).toBe(6 * day);
    expect(body.aggregateAvailability.downtimeDeviceSeconds).toBe(5 * 3600);
    expect(body.aggregateAvailability.unknownDeviceSeconds).toBe(0);
    expect(body.aggregateAvailability.confirmedDeviceSeconds).toBe(6 * day);
    expect(body.aggregateAvailability.coveragePercentage).toBe(100);
    expect(body.aggregateAvailability.unavailableReason).toBeNull();
    expect(body.aggregateAvailability.percentage).toBe(
      Math.round(((6 * day - 5 * 3600) / (6 * day)) * 100 * 10000) / 10000,
    );
    expect(body.aggregateAvailability.percentage).toBe(
      body.aggregateAvailability.confirmedAvailabilityPercentage,
    );
  });

  it('2/3/10/12/13. outage summary: closed camera outage + child outage, NVR untouched', async () => {
    const body = (
      await siteReliability(siteMainId).query({ window: '24h' }).expect(200)
    ).body;

    expect(body.outages.total).toBe(2);
    expect(body.outages.devicesAffected).toBe(2);
    expect(body.outages.totalDowntimeDeviceSeconds).toBe(5 * 3600);
    expect(body.outages.longest.deviceId).toBe(childDownId);
    expect(body.outages.longest.durationSeconds).toBe(3 * 3600);
    expect(body.outages.lastConfirmedRecoveryAt).not.toBeNull();

    const nvrRow = body.devices.find(
      (d: { deviceId: string }) => d.deviceId === nvrId,
    );
    expect(nvrRow.downtimeSeconds).toBe(0);
    expect(nvrRow.outageCount).toBe(0);
    expect(nvrRow.currentLinkState).toBe('ONLINE');

    // devices ordered by downtime DESC
    expect(body.devices[0].deviceId).toBe(childDownId);
    expect(body.devices[1].deviceId).toBe(camOutageId);
  });

  it('27. health DEGRADED never becomes downtime and stays "online" in current', async () => {
    const body = (
      await siteReliability(siteMainId).query({ window: '24h' }).expect(200)
    ).body;

    const degraded = body.devices.find(
      (d: { deviceId: string }) => d.deviceId === degradedCamId,
    );
    expect(degraded.currentLinkState).toBe('ONLINE');
    expect(degraded.downtimeSeconds).toBe(0);
    expect(degraded.outageCount).toBe(0);
  });

  it('4/32. NVR OFFLINE + children UNKNOWN: NVR downtime only, children lower coverage, percentage null, no fictitious child downtime', async () => {
    // Isolated single-purpose site so the scenario cannot leak into other tests.
    const site = await prisma.site.create({
      data: {
        organizationId: orgAId,
        name: 'NVR Outage Site',
        code: `NVROUT-${runId}`,
      },
    });
    const nvr = await prisma.device.create({
      data: {
        siteId: site.id,
        name: 'Outage NVR',
        externalId: `OUT-NVR-${runId}`,
        deviceType: 'RECORDER',
        monitoringMode: 'DIRECT',
        status: 'ACTIVE',
        expectedHeartbeatInterval: 30,
      },
    });
    const childA = await prisma.device.create({
      data: {
        siteId: site.id,
        name: 'Outage Child A',
        externalId: `OUT-CHILD-A-${runId}`,
        deviceType: 'CAMERA',
        monitoringMode: 'VIA_GATEWAY',
        gatewayDeviceId: nvr.id,
        status: 'ACTIVE',
        expectedHeartbeatInterval: 30,
      },
    });
    const childB = await prisma.device.create({
      data: {
        siteId: site.id,
        name: 'Outage Child B',
        externalId: `OUT-CHILD-B-${runId}`,
        deviceType: 'CAMERA',
        monitoringMode: 'VIA_GATEWAY',
        gatewayDeviceId: nvr.id,
        status: 'ACTIVE',
        expectedHeartbeatInterval: 30,
      },
    });

    try {
      // NVR: stale telemetry -> OFFLINE now; closed 2h outage in the window.
      await directTelemetry(nvr.id, site.id, {
        agoSeconds: 20 * 60,
        status: 'online',
      });
      await seedEvents(nvr.id, [
        {
          at: new Date(base - 30 * 24 * HOUR),
          link: 'ONLINE',
          eventType: 'INITIAL_STATE',
        },
        {
          at: new Date(base - 6 * HOUR),
          link: 'OFFLINE',
          previousState: 'ONLINE',
          reasons: ['HEARTBEAT_OVERDUE'],
        },
        {
          at: new Date(base - 4 * HOUR),
          link: 'ONLINE',
          previousState: 'OFFLINE',
        },
      ]);

      // Children: stale recorder observation -> UNKNOWN now; the event stream
      // goes ONLINE -> UNKNOWN 6h ago (observer lost) -> ONLINE 4h ago.
      for (const child of [childA, childB]) {
        await recorderObservation(child.id, nvr.id, {
          agoSeconds: 20 * 60,
          status: 'online',
        });
        await seedEvents(child.id, [
          {
            at: new Date(base - 30 * 24 * HOUR),
            link: 'ONLINE',
            eventType: 'INITIAL_STATE',
          },
          {
            at: new Date(base - 6 * HOUR),
            link: 'UNKNOWN',
            previousState: 'ONLINE',
            reasons: ['STALE_OBSERVATION'],
          },
          {
            at: new Date(base - 4 * HOUR),
            link: 'ONLINE',
            previousState: 'UNKNOWN',
          },
        ]);
      }

      const body = (
        await siteReliability(site.id).query({ window: '24h' }).expect(200)
      ).body;

      expect(body.population.eligibleDevices).toBe(3);

      // current: nvr OFFLINE, 2 children UNKNOWN
      expect(body.current).toEqual({
        online: 0,
        offline: 1,
        unknown: 2,
        neverSeen: 0,
      });

      // exactly one outage (the NVR), children contribute no downtime
      expect(body.outages.total).toBe(1);
      expect(body.outages.devicesAffected).toBe(1);
      expect(body.outages.longest.deviceId).toBe(nvr.id);
      expect(body.outages.longest.durationSeconds).toBe(2 * 3600);

      const childRow = body.devices.find(
        (d: { deviceId: string }) => d.deviceId === childA.id,
      );
      expect(childRow.downtimeSeconds).toBe(0);
      expect(childRow.unknownSeconds).toBe(2 * 3600);
      expect(childRow.currentLinkState).toBe('UNKNOWN');

      // aggregate: real 2h downtime on the NVR, 4h UNKNOWN pool -> percentage null
      expect(body.aggregateAvailability.downtimeDeviceSeconds).toBe(2 * 3600);
      expect(body.aggregateAvailability.unknownDeviceSeconds).toBe(4 * 3600);
      expect(body.aggregateAvailability.percentage).toBeNull();
      expect(body.aggregateAvailability.unavailableReason).toBe(
        'INCOMPLETE_COVERAGE',
      );
      // confirmed-only figure still there
      expect(
        body.aggregateAvailability.confirmedAvailabilityPercentage,
      ).not.toBeNull();
    } finally {
      await prisma.deviceConnectivityEvent.deleteMany({
        where: { deviceId: { in: [nvr.id, childA.id, childB.id] } },
      });
      await prisma.recorderObservationSnapshot.deleteMany({
        where: { deviceId: { in: [childA.id, childB.id] } },
      });
      await prisma.deviceTelemetrySnapshot.deleteMany({
        where: { deviceId: nvr.id },
      });
      await prisma.device.deleteMany({
        where: { id: { in: [nvr.id, childA.id, childB.id] } },
      });
      await prisma.site.delete({ where: { id: site.id } });
    }
  });

  it('5/6/16/25/26. gap site: a never-seen device is NO_DATA, never uptime; percentage null but confirmed figure absent', async () => {
    const body = (
      await siteReliability(siteGapId).query({ window: '24h' }).expect(200)
    ).body;

    expect(body.population.eligibleDevices).toBe(1);
    const row = body.devices[0];
    expect(row.deviceId).toBe(neverCamId);
    expect(row.currentLinkState).toBe('NEVER_SEEN');
    expect(row.uptimeSeconds).toBe(0);
    expect(row.downtimeSeconds).toBe(0);
    expect(row.unknownSeconds).toBeGreaterThan(0);

    expect(body.aggregateAvailability.uptimeDeviceSeconds).toBe(0);
    expect(body.aggregateAvailability.confirmedDeviceSeconds).toBe(0);
    expect(body.aggregateAvailability.percentage).toBeNull();
    expect(
      body.aggregateAvailability.confirmedAvailabilityPercentage,
    ).toBeNull();
    expect(body.aggregateAvailability.unavailableReason).toBe(
      'NO_CONFIRMED_OBSERVATION',
    );
  });

  it('7/33. empty site: percentage null, never 100%', async () => {
    const body = (
      await siteReliability(siteEmptyId).query({ window: '24h' }).expect(200)
    ).body;

    expect(body.population.eligibleDevices).toBe(0);
    expect(body.population.excludedDevices).toBe(0);
    expect(body.current).toEqual({
      online: 0,
      offline: 0,
      unknown: 0,
      neverSeen: 0,
    });
    expect(body.aggregateAvailability.percentage).toBeNull();
    expect(body.aggregateAvailability.coveragePercentage).toBeNull();
    expect(body.aggregateAvailability.unavailableReason).toBe(
      'NO_ELIGIBLE_DEVICES',
    );
    expect(body.outages.total).toBe(0);
    expect(body.devices).toEqual([]);
  });

  it('15/17/18. solo site: single device fully covered -> percentage 100', async () => {
    const body = (
      await siteReliability(siteSoloId).query({ window: '24h' }).expect(200)
    ).body;

    expect(body.population.eligibleDevices).toBe(1);
    expect(body.aggregateAvailability.percentage).toBe(100);
    expect(body.aggregateAvailability.confirmedAvailabilityPercentage).toBe(
      100,
    );
    expect(body.aggregateAvailability.coveragePercentage).toBe(100);
  });

  // ---- administrative status -----------------------------------------

  it('status: only ACTIVE devices join the reliability population; non-ACTIVE stay individually queryable', async () => {
    const site = await prisma.site.create({
      data: {
        organizationId: orgAId,
        name: 'Status Site',
        code: `STATUS-${runId}`,
      },
    });

    const mkStatus = (
      name: string,
      externalId: string,
      status: 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE' | 'DECOMMISSIONED',
    ) =>
      prisma.device.create({
        data: {
          siteId: site.id,
          name,
          externalId: `${externalId}-${runId}`,
          deviceType: 'CAMERA',
          monitoringMode: 'DIRECT',
          status,
          expectedHeartbeatInterval: 60,
        },
      });

    const activeCam = await mkStatus('Active Cam', 'ST-ACTIVE', 'ACTIVE');
    const inactiveCam = await mkStatus('Inactive Cam', 'ST-INACTIVE', 'INACTIVE');
    const maintCam = await mkStatus('Maint Cam', 'ST-MAINT', 'MAINTENANCE');
    const decommCam = await mkStatus(
      'Decommissioned Cam',
      'ST-DECOMM',
      'DECOMMISSIONED',
    );

    try {
      const anchor = new Date(base - 30 * 24 * HOUR);

      // ACTIVE camera: full 24h ONLINE coverage.
      await directTelemetry(activeCam.id, site.id, {
        agoSeconds: 30,
        status: 'online',
      });
      await seedEvents(activeCam.id, [
        { at: anchor, link: 'ONLINE', eventType: 'INITIAL_STATE' },
      ]);

      // DECOMMISSIONED camera: it still has history — the individual endpoint
      // must keep working even though reliability ignores it.
      await seedEvents(decommCam.id, [
        { at: anchor, link: 'ONLINE', eventType: 'INITIAL_STATE' },
      ]);

      const body = (
        await siteReliability(site.id).query({ window: '24h' }).expect(200)
      ).body;

      // population: only the ACTIVE camera is eligible; the other 3 are excluded
      // under a single folded reason.
      expect(body.population.eligibleDevices).toBe(1);
      expect(body.population.excludedDevices).toBe(3);
      expect(body.population.excludedByReason).toEqual({
        ADMINISTRATIVE_STATUS_NOT_ACTIVE: 3,
      });

      // the 3 non-ACTIVE devices (which have no fresh telemetry) do NOT decay
      // coverage or availability.
      const day = 24 * 3600;
      expect(body.aggregateAvailability.expectedDeviceSeconds).toBe(day);
      expect(body.aggregateAvailability.unknownDeviceSeconds).toBe(0);
      expect(body.aggregateAvailability.coveragePercentage).toBe(100);
      expect(body.aggregateAvailability.percentage).toBe(100);
      expect(body.aggregateAvailability.unavailableReason).toBeNull();

      // current counts only the ACTIVE device.
      expect(body.current).toEqual({
        online: 1,
        offline: 0,
        unknown: 0,
        neverSeen: 0,
      });
      expect(body.devices).toHaveLength(1);
      expect(body.devices[0].deviceId).toBe(activeCam.id);

      // historical queryability is unchanged for a non-ACTIVE device.
      const decommAvailability = (
        await request(app.getHttpServer())
          .get(`${API}/devices/${decommCam.id}/availability`)
          .set(bearer(adminToken))
          .query({ window: '24h' })
          .expect(200)
      ).body;
      expect(decommAvailability.deviceId).toBe(decommCam.id);
      expect(decommAvailability.availability).toBeDefined();

      // a non-ACTIVE device with no history is still a valid 200, not a 4xx.
      await request(app.getHttpServer())
        .get(`${API}/devices/${inactiveCam.id}/availability`)
        .set(bearer(adminToken))
        .query({ window: '24h' })
        .expect(200);
    } finally {
      await prisma.deviceConnectivityEvent.deleteMany({
        where: {
          deviceId: {
            in: [activeCam.id, inactiveCam.id, maintCam.id, decommCam.id],
          },
        },
      });
      await prisma.deviceTelemetrySnapshot.deleteMany({
        where: { deviceId: activeCam.id },
      });
      await prisma.device.deleteMany({
        where: {
          id: {
            in: [activeCam.id, inactiveCam.id, maintCam.id, decommCam.id],
          },
        },
      });
      await prisma.site.delete({ where: { id: site.id } });
    }
  });

  // ---- fleet scope --------------------------------------------------

  it('19/20/21. fleet aggregate is pooled device-seconds, not a mean of site percentages', async () => {
    const body = (await fleetReliability().query({ window: '24h' }).expect(200))
      .body;

    expect(body.population.sites).toBe(4);
    expect(body.population.eligibleDevices).toBe(8); // 6 main + 1 solo + 1 gap
    expect(body.population.sitesWithEligibleDevices).toBe(3);

    // pooled: sum of every eligible device's seconds
    const day = 24 * 3600;
    const agg = body.aggregateAvailability;
    expect(agg.expectedDeviceSeconds).toBe(8 * day);
    expect(agg.downtimeDeviceSeconds).toBe(5 * 3600); // main site only
    // gap site's never-seen camera keeps org coverage incomplete
    expect(agg.unknownDeviceSeconds).toBeGreaterThan(0);
    expect(agg.percentage).toBeNull();
    expect(agg.unavailableReason).toBe('INCOMPLETE_COVERAGE');

    // the pooled confirmed figure equals uptime/confirmed device-seconds ...
    expect(agg.confirmedAvailabilityPercentage).toBeCloseTo(
      (agg.uptimeDeviceSeconds / agg.confirmedDeviceSeconds) * 100,
      3,
    );

    // ... and it is NOT the arithmetic mean of the per-site confirmed figures
    const siteConfirmed = body.sites
      .map(
        (s: { confirmedAvailabilityPercentage: number | null }) =>
          s.confirmedAvailabilityPercentage,
      )
      .filter((v: number | null): v is number => v !== null);
    const mean =
      siteConfirmed.reduce((sum: number, v: number) => sum + v, 0) /
      siteConfirmed.length;
    expect(
      Math.abs(agg.confirmedAvailabilityPercentage - mean),
    ).toBeGreaterThan(0.3);

    // per-site rows carry their own (independent) figures
    const solo = body.sites.find(
      (s: { siteId: string }) => s.siteId === siteSoloId,
    );
    expect(solo.eligibleDevices).toBe(1);
    expect(solo.availabilityPercentage).toBe(100);

    const main = body.sites.find(
      (s: { siteId: string }) => s.siteId === siteMainId,
    );
    expect(main.eligibleDevices).toBe(6);
    expect(main.downtimeDeviceSeconds).toBe(5 * 3600);

    // sites ordered by downtime DESC -> main first
    expect(body.sites[0].siteId).toBe(siteMainId);
  });

  it('fleet current counts fold every site', async () => {
    const body = (await fleetReliability().query({ window: '24h' }).expect(200))
      .body;

    // 5 online (main) + 1 online (solo) = 6; 1 offline (child); 1 never-seen (gap)
    expect(body.current).toEqual({
      online: 6,
      offline: 1,
      unknown: 0,
      neverSeen: 1,
    });
  });

  // ---- read-only ----------------------------------------------------

  it('29. GET is strictly read-only — no telemetry / event / alert / lastSeen mutation', async () => {
    const before = await snapshotState();

    await siteReliability(siteMainId).query({ window: '30d' }).expect(200);
    await siteReliability(siteGapId).query({ window: '7d' }).expect(200);
    await siteReliability(siteSoloId).expect(200);
    await fleetReliability().query({ window: '30d' }).expect(200);
    await fleetReliability().expect(200);

    const after = await snapshotState();
    expect(after).toEqual(before);
  });

  async function snapshotState() {
    const filter = { site: { organizationId: orgAId } };
    const [devices, telemetry, observations, alerts, events] =
      await Promise.all([
        prisma.device.findMany({
          where: filter,
          select: { id: true, updatedAt: true },
          orderBy: { id: 'asc' },
        }),
        prisma.deviceTelemetrySnapshot.findMany({
          where: { device: filter },
          select: { deviceId: true, updatedAt: true, observedAt: true },
          orderBy: { deviceId: 'asc' },
        }),
        prisma.recorderObservationSnapshot.findMany({
          where: { device: filter },
          select: { deviceId: true, updatedAt: true, observedAt: true },
          orderBy: { deviceId: 'asc' },
        }),
        prisma.alert.count({ where: { device: filter } }),
        prisma.deviceConnectivityEvent.count({ where: { device: filter } }),
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
