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
  adapter: new PrismaPg({
    connectionString: DATABASE_URL,
  }),
});

const API = '/api/v1';

const PASSWORD = 'LocalTelemetryPassword123!';

interface LoginBody {
  stage: 'AUTHENTICATED';
  accessToken: string;
}

function bearer(token: string): {
  Authorization: string;
} {
  return {
    Authorization: `Bearer ${token}`,
  };
}

describe('PSOP local telemetry ingestion', () => {
  let app: INestApplication;

  const runId = randomUUID().slice(0, 8);

  const organizationIds: string[] = [];

  let organizationAId: string;
  let organizationBId: string;
  let siteAId: string;
  let siteBId: string;
  let localDeviceId: string;
  let foreignDeviceId: string;
  let gatewayDeviceId: string;
  let recorderDeviceId: string;
  let recorderChildDeviceId: string;
  let adminEmail: string;
  let viewerEmail: string;
  let adminToken: string;
  let viewerToken: string;
  let deviceKey: string;
  let recorderKey: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'local-telemetry-access-secret-long-enough';
    process.env.JWT_REFRESH_SECRET =
      'local-telemetry-refresh-secret-long-enough';
    process.env.JWT_EXPIRES_SECONDS = '900';
    process.env.JWT_REFRESH_EXPIRES_SECONDS = '3600';
    process.env.MFA_ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef' + '0123456789abcdef0123456789abcdef';
    process.env.CONNECTIVITY_MONITOR_ENABLED = 'false';
    process.env.TELEMETRY_DEMO_MODE = 'false';
    process.env.LOCAL_TELEMETRY_INGESTION_ENABLED = 'true';
    process.env.AWS_REGION = 'us-east-1';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();

    app.setGlobalPrefix('api');

    app.enableVersioning({
      type: VersioningType.URI,
    });

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );

    await app.init();
    await prisma.$connect();

    const [organizationA, organizationB] = await Promise.all([
      prisma.organization.create({
        data: {
          name: `Local Telemetry A ${runId}`,
          slug: `local-telemetry-a-${runId}`,
        },
      }),
      prisma.organization.create({
        data: {
          name: `Local Telemetry B ${runId}`,
          slug: `local-telemetry-b-${runId}`,
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
          name: 'Local Telemetry Site A',
          code: `LOCAL-A-${runId}`,
          timezone: 'America/New_York',
        },
      }),
      prisma.site.create({
        data: {
          organizationId: organizationBId,
          name: 'Local Telemetry Site B',
          code: `LOCAL-B-${runId}`,
          timezone: 'America/New_York',
        },
      }),
    ]);

    siteAId = siteA.id;
    siteBId = siteB.id;

    adminEmail = `local-admin-${runId}@psop.test`;

    viewerEmail = `local-viewer-${runId}@psop.test`;

    const passwordHash = await hash(PASSWORD, 12);

    await Promise.all([
      prisma.user.create({
        data: {
          organizationId: organizationAId,
          name: 'Local Telemetry Admin',
          email: adminEmail,
          passwordHash,
          role: 'ADMIN',
          mustChangePassword: false,
        },
      }),
      prisma.user.create({
        data: {
          organizationId: organizationAId,
          name: 'Local Telemetry Viewer',
          email: viewerEmail,
          passwordHash,
          role: 'VIEWER',
          mustChangePassword: false,
        },
      }),
    ]);

    const [localDevice, foreignDevice] = await Promise.all([
      prisma.device.create({
        data: {
          siteId: siteAId,
          name: 'Local Camera A',
          externalId: `LOCAL-CAM-A-${runId}`,
          deviceType: 'CAMERA',
          status: 'ACTIVE',
          expectedHeartbeatInterval: 60,
        },
      }),
      prisma.device.create({
        data: {
          siteId: siteBId,
          name: 'Foreign Camera B',
          externalId: `LOCAL-CAM-B-${runId}`,
          deviceType: 'CAMERA',
          status: 'ACTIVE',
          expectedHeartbeatInterval: 60,
        },
      }),
    ]);

    localDeviceId = localDevice.id;
    foreignDeviceId = foreignDevice.id;

    const gatewayDevice =
      await prisma.device.create({
        data: {
          siteId: siteAId,
          name: 'Local Edge Gateway',
          externalId:
            `LOCAL-GATEWAY-${runId}`,
          deviceType: 'GATEWAY',
          monitoringMode: 'DIRECT',
          status: 'ACTIVE',
          expectedHeartbeatInterval: 60,
        },
      });

    gatewayDeviceId = gatewayDevice.id;

    const recorderDevice =
      await prisma.device.create({
        data: {
          siteId: siteAId,
          name: 'NVR Speco Test Recorder',
          externalId:
            `NVR-SPECO-${runId}`,
          deviceType: 'RECORDER',
          monitoringMode: 'DIRECT',
          manufacturer: 'Speco',
          model: 'N8NRL',
          status: 'ACTIVE',
          expectedHeartbeatInterval: 30,
        },
      });

    recorderDeviceId = recorderDevice.id;

    const recorderChild =
      await prisma.device.create({
        data: {
          siteId: siteAId,
          name: 'Recorder Observed Camera',
          externalId:
            `NVR-SPECO-CAM-${runId}`,
          deviceType: 'CAMERA',
          monitoringMode: 'VIA_GATEWAY',
          gatewayDeviceId:
            recorderDeviceId,
          manufacturer: 'Hikvision',
          model: 'DS-2CD2122FWD-IS',
          status: 'ACTIVE',
          expectedHeartbeatInterval: 30,
        },
      });

    recorderChildDeviceId =
      recorderChild.id;

    adminToken = await login(adminEmail);

    viewerToken = await login(viewerEmail);
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({
      where: {
        organizationId: {
          in: organizationIds,
        },
      },
    });

    await prisma.userSession.deleteMany({
      where: {
        organizationId: {
          in: organizationIds,
        },
      },
    });

    await prisma.authChallenge.deleteMany({
      where: {
        organizationId: {
          in: organizationIds,
        },
      },
    });

    await prisma.alert.deleteMany({
      where: {
        device: {
          site: {
            organizationId: {
              in: organizationIds,
            },
          },
        },
      },
    });

    await prisma.deviceConnectivityEvent.deleteMany({
      where: {
        device: {
          site: {
            organizationId: {
              in: organizationIds,
            },
          },
        },
      },
    });

    await prisma.edgeAgentRuntimeSnapshot.deleteMany({
      where: {
        device: {
          site: {
            organizationId: {
              in: organizationIds,
            },
          },
        },
      },
    });

    await prisma.recorderObservationSnapshot.deleteMany({
      where: {
        device: {
          site: {
            organizationId: {
              in: organizationIds,
            },
          },
        },
      },
    });

    await prisma.deviceTelemetrySnapshot.deleteMany({
      where: {
        device: {
          site: {
            organizationId: {
              in: organizationIds,
            },
          },
        },
      },
    });

    await prisma.deviceIngestionCredential.deleteMany({
      where: {
        device: {
          site: {
            organizationId: {
              in: organizationIds,
            },
          },
        },
      },
    });

    await prisma.device.deleteMany({
      where: {
        site: {
          organizationId: {
            in: organizationIds,
          },
        },
      },
    });

    await prisma.user.deleteMany({
      where: {
        organizationId: {
          in: organizationIds,
        },
      },
    });

    await prisma.site.deleteMany({
      where: {
        organizationId: {
          in: organizationIds,
        },
      },
    });

    await prisma.organization.deleteMany({
      where: {
        id: {
          in: organizationIds,
        },
      },
    });

    await prisma.$disconnect();
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({
        email,
        password: PASSWORD,
      })
      .expect(200);

    return (response.body as LoginBody).accessToken;
  }

  function telemetryPayload(overrides: Record<string, unknown> = {}) {
    return {
      timestamp: Math.floor(Date.now() / 1000),
      status: 'online',
      temperatureC: 44,
      bitrateKbps: 4200,
      storageUsedPct: 52,
      uptimeSeconds: 7200,
      model: 'Local Test Camera',
      firmware: 'test-1.0.0',
      ...overrides,
    };
  }

  it('returns safe unconfigured credential status', async () => {
    const adminResponse = await request(app.getHttpServer())
      .get(`${API}/devices/${localDeviceId}/ingestion-key`)
      .set(bearer(adminToken))
      .expect(200);

    expect(adminResponse.body).toEqual({
      enabled: true,
      configured: false,
      keyPrefix: null,
      rotatedAt: null,
    });

    expect(JSON.stringify(adminResponse.body)).not.toContain('deviceKey');

    await request(app.getHttpServer())
      .get(`${API}/devices/${localDeviceId}/ingestion-key`)
      .set(bearer(viewerToken))
      .expect(200);

    await request(app.getHttpServer())
      .get(`${API}/devices/${foreignDeviceId}/ingestion-key`)
      .set(bearer(adminToken))
      .expect(404);
  });

  it('rotates a one-time key with role and tenant isolation', async () => {
    await request(app.getHttpServer())
      .post(`${API}/devices/${localDeviceId}/ingestion-key/rotate`)
      .set(bearer(viewerToken))
      .expect(403);

    await request(app.getHttpServer())
      .post(`${API}/devices/${foreignDeviceId}/ingestion-key/rotate`)
      .set(bearer(adminToken))
      .expect(404);

    const response = await request(app.getHttpServer())
      .post(`${API}/devices/${localDeviceId}/ingestion-key/rotate`)
      .set(bearer(adminToken))
      .expect(201);

    deviceKey = response.body.deviceKey;

    expect(deviceKey).toMatch(/^psop_cam_[A-Za-z0-9_-]{43}$/);

    const credential = await prisma.deviceIngestionCredential.findUniqueOrThrow(
      {
        where: {
          deviceId: localDeviceId,
        },
      },
    );

    expect(credential.keyHash).not.toContain(deviceKey);

    const auditLogs = await prisma.auditLog.findMany({
      where: {
        organizationId: organizationAId,
      },
    });

    expect(JSON.stringify(auditLogs)).not.toContain(deviceKey);
  });

  it('returns configured status without exposing the raw key', async () => {
    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${localDeviceId}/ingestion-key`)
      .set(bearer(adminToken))
      .expect(200);

    expect(response.body.enabled).toBe(true);

    expect(response.body.configured).toBe(true);

    expect(response.body.keyPrefix).toMatch(/^psop_cam_/);

    expect(typeof response.body.rotatedAt).toBe('string');

    expect(JSON.stringify(response.body)).not.toContain(deviceKey);

    expect(response.body.deviceKey).toBeUndefined();
  });

  it('accepts authenticated telemetry from a direct gateway', async () => {
    const rotation = await request(
      app.getHttpServer(),
    )
      .post(
        `${API}/devices/${gatewayDeviceId}/ingestion-key/rotate`,
      )
      .set(bearer(adminToken))
      .expect(201);

    const gatewayKey =
      rotation.body.deviceKey;

    const response = await request(
      app.getHttpServer(),
    )
      .post(`${API}/telemetry/ingest`)
      .set('x-device-id', gatewayDeviceId)
      .set('x-device-key', gatewayKey)
      .send(
        telemetryPayload({
          model: 'Local Edge Gateway',
          firmware: 'gateway-1.0.0',
          agentVersion: '1.2.0',
          runtimeStartedAt:
            new Date(
              Date.now() - 5000,
            ).toISOString(),
          runtimeUptimeSeconds: 5,
          previousDeliveryState:
            'BUFFERED',
          pendingBufferCount: 1,
          lastSuccessfulDeliveryAt:
            new Date(
              Date.now() - 60000,
            ).toISOString(),
          lastDeliveryError:
            'temporary API outage',
          lastDeliveryErrorAt:
            new Date(
              Date.now() - 30000,
            ).toISOString(),
        }),
      )
      .expect(201);

    expect(
      response.body.device.deviceType,
    ).toBe('GATEWAY');

    expect(
      response.body.connectivity.state,
    ).toBe('ONLINE');

    const details = await request(
      app.getHttpServer(),
    )
      .get(
        `${API}/devices/${gatewayDeviceId}/telemetry`,
      )
      .set(bearer(adminToken))
      .expect(200);

    expect(
      details.body.telemetry.model,
    ).toBe('Local Edge Gateway');

    const fleet = await request(
      app.getHttpServer(),
    )
      .get(`${API}/devices/telemetry`)
      .set(bearer(adminToken))
      .expect(200);

    expect(
      fleet.body.devices.some(
        (device: {
          device: {
            id: string;
            deviceType: string;
          };
        }) =>
          device.device.id ===
            gatewayDeviceId &&
          device.device.deviceType ===
            'GATEWAY',
      ),
    ).toBe(true);

    const overview = await request(
      app.getHttpServer(),
    )
      .get(`${API}/operations/overview`)
      .set(bearer(adminToken))
      .expect(200);

    const edgeAgent =
      overview.body.edgeAgents.find(
        (agent: {
          device: { id: string };
        }) =>
          agent.device.id ===
          gatewayDeviceId,
      );

    expect(edgeAgent).toBeDefined();
    expect(
      edgeAgent.runtime.agentVersion,
    ).toBe('1.2.0');
    expect(
      edgeAgent.runtime.deliveryState,
    ).toBe('DELIVERED');
    expect(
      edgeAgent.runtime.previousDeliveryState,
    ).toBe('BUFFERED');
    expect(
      edgeAgent.runtime.pendingBufferCount,
    ).toBe(1);
    expect(
      edgeAgent.runtime.lastDeliveryError,
    ).toBe('temporary API outage');
    expect(
      edgeAgent.report.freshness,
    ).toBe('REPORTING');
  });

  it('accepts recorder-verified child telemetry with recorder identity', async () => {
    const rotation = await request(
      app.getHttpServer(),
    )
      .post(
        `${API}/devices/${recorderDeviceId}/ingestion-key/rotate`,
      )
      .set(bearer(adminToken))
      .expect(201);

    recorderKey =
      rotation.body.deviceKey;

    const online = await request(
      app.getHttpServer(),
    )
      .post(
        `${API}/telemetry/recorder-observations`,
      )
      .set(
        'x-device-id',
        recorderDeviceId,
      )
      .set(
        'x-device-key',
        recorderKey,
      )
      .send({
        timestamp:
          Math.floor(Date.now() / 1000),
        observations: [
          {
            deviceId:
              recorderChildDeviceId,
            status: 'online',
            channelId:
              '{00000002-0000-0000-0000-000000000000}',
            channelNumber: 2,
            poePort: 2,
            poePowerW: 3.19,
            recordingStatus:
              'recordingAbnormal',
            protocol: 'ONVIF',
            bitrateKbps: 3072,
            resolution: '1920x1080',
            frameRate: 30,
            model:
              'DS-2CD2122FWD-IS',
          },
        ],
      })
      .expect(201);

    expect(online.body.accepted).toBe(1);

    expect(
      online.body.observations[0]
        .monitoring
        .individualVerification,
    ).toBe('RECORDER_VERIFIED');

    expect(
      online.body.observations[0]
        .connectivity.state,
    ).toBe('ONLINE');

    expect(
      online.body.observations[0]
        .telemetry.poePowerW,
    ).toBe(3.19);

    expect(
      online.body.observations[0]
        .telemetry.recordingStatus,
    ).toBe('recordingAbnormal');

    await request(
      app.getHttpServer(),
    )
      .post(
        `${API}/telemetry/recorder-observations`,
      )
      .set(
        'x-device-id',
        recorderDeviceId,
      )
      .set(
        'x-device-key',
        recorderKey,
      )
      .send({
        timestamp:
          Math.floor(Date.now() / 1000),
        observations: [
          {
            deviceId:
              recorderChildDeviceId,
            status: 'offline',
            channelNumber: 2,
            poePort: 2,
            poePowerW: 0,
            protocol: 'ONVIF',
          },
        ],
      })
      .expect(201)
      .expect((response) => {
        expect(
          response.body.observations[0]
            .connectivity.state,
        ).toBe('OFFLINE');
      });

    const openAlert =
      await prisma.alert.findFirst({
        where: {
          deviceId:
            recorderChildDeviceId,
          status: 'OPEN',
          severity: 'CRITICAL',
          connectivityState:
            'OFFLINE',
        },
      });

    expect(openAlert).not.toBeNull();

    expect(openAlert?.title).toBe(
      'Recorder Observed Camera is offline',
    );

    expect(openAlert?.message).toBe(
      'Recorder Observed Camera is offline according to NVR Speco Test Recorder on channel 2.',
    );

    expect(openAlert?.context).toEqual(
      expect.objectContaining({
        reasons: expect.arrayContaining([
          'REPORTED_OFFLINE',
          'RECORDER_VERIFIED_OFFLINE',
        ]),
        monitoringSource: 'RECORDER_OBSERVED',
        individualVerification: 'RECORDER_VERIFIED',
        observerDeviceId: recorderDeviceId,
        observerDeviceName: 'NVR Speco Test Recorder',
        channelNumber: 2,
      }),
    );

    const recorderOwnTelemetry =
      await request(app.getHttpServer())
        .get(
          `${API}/devices/${recorderDeviceId}/telemetry`,
        )
        .set(bearer(adminToken))
        .expect(200);

    expect(
      recorderOwnTelemetry.body.connectivity.state,
    ).not.toBe('OFFLINE');

    // The recorder never sends its own DIRECT telemetry in this fixture,
    // so it may legitimately carry its own NEVER_SEEN alert — but the
    // child camera's OFFLINE state must never leak into it.
    const recorderOwnOfflineAlert =
      await prisma.alert.findFirst({
        where: {
          deviceId: recorderDeviceId,
          status: 'OPEN',
          connectivityState: 'OFFLINE',
        },
      });

    expect(recorderOwnOfflineAlert).toBeNull();

    const events = await request(
      app.getHttpServer(),
    )
      .get(
        `${API}/devices/${recorderChildDeviceId}/connectivity-events`,
      )
      .set(bearer(adminToken))
      .expect(200);

    expect(
      events.body.events.some(
        (event: {
          current_state: string;
        }) =>
          event.current_state ===
          'OFFLINE',
      ),
    ).toBe(true);

    await request(
      app.getHttpServer(),
    )
      .post(
        `${API}/telemetry/recorder-observations`,
      )
      .set(
        'x-device-id',
        recorderDeviceId,
      )
      .set(
        'x-device-key',
        recorderKey,
      )
      .send({
        timestamp:
          Math.floor(Date.now() / 1000),
        observations: [
          {
            deviceId:
              recorderChildDeviceId,
            status: 'online',
            channelNumber: 2,
            poePort: 2,
            poePowerW: 3.14,
            protocol: 'ONVIF',
          },
        ],
      })
      .expect(201);

    const resolvedAlert =
      await prisma.alert.findFirst({
        where: {
          deviceId:
            recorderChildDeviceId,
          status: 'RESOLVED',
          connectivityState:
            'ONLINE',
        },
      });

    expect(resolvedAlert).not.toBeNull();


    await prisma.recorderObservationSnapshot.update({
      where: {
        deviceId:
          recorderChildDeviceId,
      },
      data: {
        observedAt: new Date(
          Date.now() - 120_000,
        ),
      },
    });

    const staleRecorderTelemetry =
      await request(
        app.getHttpServer(),
      )
        .get(
          `${API}/devices/${recorderChildDeviceId}/telemetry`,
        )
        .set(bearer(adminToken))
        .expect(200);

    expect(
      staleRecorderTelemetry.body
        .monitoring
        .individualVerification,
    ).toBe('RECORDER_VERIFIED');

    expect(
      staleRecorderTelemetry.body
        .connectivity.state,
    ).toBe('UNKNOWN');

    expect(
      staleRecorderTelemetry.body
        .connectivity.reasons,
    ).toEqual(['STALE_OBSERVATION']);

    await request(
      app.getHttpServer(),
    )
      .post(
        `${API}/telemetry/recorder-observations`,
      )
      .set(
        'x-device-id',
        recorderDeviceId,
      )
      .set(
        'x-device-key',
        recorderKey,
      )
      .send({
        timestamp:
          Math.floor(Date.now() / 1000),
        observations: [
          {
            deviceId: localDeviceId,
            status: 'online',
          },
        ],
      })
      .expect(400);
  });

  it('does not spawn a duplicate incident when the same OFFLINE state is polled repeatedly, and opens a fresh incident after recovery', async () => {
    async function postObservation(
      status: 'online' | 'offline',
    ) {
      return request(app.getHttpServer())
        .post(`${API}/telemetry/recorder-observations`)
        .set('x-device-id', recorderDeviceId)
        .set('x-device-key', recorderKey)
        .send({
          timestamp: Math.floor(Date.now() / 1000),
          observations: [
            {
              deviceId: recorderChildDeviceId,
              status,
              channelNumber: 2,
              poePort: 2,
              poePowerW: status === 'online' ? 3.19 : 0,
              protocol: 'ONVIF',
            },
          ],
        })
        .expect(201);
    }

    async function connectivityEventCount(): Promise<number> {
      const response = await request(app.getHttpServer())
        .get(
          `${API}/devices/${recorderChildDeviceId}/connectivity-events`,
        )
        .set(bearer(adminToken))
        .expect(200);

      return response.body.events.length;
    }

    // First drop after the previous test's recovery.
    await postObservation('offline');

    const firstIncident = await prisma.alert.findFirstOrThrow({
      where: {
        deviceId: recorderChildDeviceId,
        status: 'OPEN',
      },
    });

    const eventCountAfterFirstDrop =
      await connectivityEventCount();

    // Poll the same OFFLINE state twice more.
    await postObservation('offline');
    await postObservation('offline');

    const openIncidentsAfterPolling =
      await prisma.alert.findMany({
        where: {
          deviceId: recorderChildDeviceId,
          status: 'OPEN',
        },
      });

    expect(openIncidentsAfterPolling).toHaveLength(1);
    expect(openIncidentsAfterPolling[0].id).toBe(
      firstIncident.id,
    );
    expect(
      openIncidentsAfterPolling[0].openedAt.getTime(),
    ).toBe(firstIncident.openedAt.getTime());
    expect(
      openIncidentsAfterPolling[0].lastDetectedAt.getTime(),
    ).toBeGreaterThanOrEqual(
      firstIncident.lastDetectedAt.getTime(),
    );

    expect(await connectivityEventCount()).toBe(
      eventCountAfterFirstDrop,
    );

    // Recover, then drop again: this must open a brand new incident.
    await postObservation('online');

    const resolvedIncident =
      await prisma.alert.findFirstOrThrow({
        where: {
          id: firstIncident.id,
        },
      });

    expect(resolvedIncident.status).toBe('RESOLVED');

    await postObservation('offline');

    const secondIncident =
      await prisma.alert.findFirstOrThrow({
        where: {
          deviceId: recorderChildDeviceId,
          status: 'OPEN',
        },
      });

    expect(secondIncident.id).not.toBe(firstIncident.id);
    expect(
      secondIncident.openedAt.getTime(),
    ).toBeGreaterThan(firstIncident.openedAt.getTime());

    // Bring the fixture back to a healthy state for later tests.
    await postObservation('online');
  });

  it(
    'rejects an older recorder batch without regressing current truth',
    async () => {
      const newerTimestamp =
        Math.floor(Date.now() / 1000);

      await request(
        app.getHttpServer(),
      )
        .post(
          `${API}/telemetry/recorder-observations`,
        )
        .set(
          'x-device-id',
          recorderDeviceId,
        )
        .set(
          'x-device-key',
          recorderKey,
        )
        .send({
          timestamp: newerTimestamp,
          observations: [
            {
              deviceId:
                recorderChildDeviceId,
              status: 'online',
              channelNumber: 2,
              poePort: 2,
              poePowerW: 3.19,
              protocol: 'ONVIF',
            },
          ],
        })
        .expect(201);

      await request(
        app.getHttpServer(),
      )
        .post(
          `${API}/telemetry/recorder-observations`,
        )
        .set(
          'x-device-id',
          recorderDeviceId,
        )
        .set(
          'x-device-key',
          recorderKey,
        )
        .send({
          timestamp: newerTimestamp - 30,
          observations: [
            {
              deviceId:
                recorderChildDeviceId,
              status: 'offline',
              channelNumber: 2,
              poePort: 2,
              poePowerW: 0,
              protocol: 'ONVIF',
            },
          ],
        })
        .expect(400);

      const telemetry = await request(
        app.getHttpServer(),
      )
        .get(
          `${API}/devices/${recorderChildDeviceId}/telemetry`,
        )
        .set(bearer(adminToken))
        .expect(200);

      expect(
        telemetry.body.connectivity.state,
      ).toBe('ONLINE');

      expect(
        telemetry.body.telemetry.poePowerW,
      ).toBe(3.19);
    },
  );

  it(
    'does not reuse recorder verification after a child is reassigned',
    async () => {
      await prisma.device.update({
        where: {
          id: recorderChildDeviceId,
        },
        data: {
          gatewayDeviceId,
        },
      });

      try {
        const telemetry = await request(
          app.getHttpServer(),
        )
          .get(
            `${API}/devices/${recorderChildDeviceId}/telemetry`,
          )
          .set(bearer(adminToken))
          .expect(200);

        expect(
          telemetry.body.monitoring
            .individualVerification,
        ).toBe('NOT_VERIFIED');

        expect(
          telemetry.body.monitoring.source,
        ).toBe('GATEWAY_DERIVED');

        const overview = await request(
          app.getHttpServer(),
        )
          .get(`${API}/operations/overview`)
          .set(bearer(adminToken))
          .expect(200);

        const managed =
          overview.body.gatewayManaged.find(
            (item: {
              device: {
                id: string;
              };
            }) =>
              item.device.id ===
              recorderChildDeviceId,
          );

        expect(managed).toBeDefined();
        expect(
          managed.monitoring
            .individualVerification,
        ).toBe('NOT_VERIFIED');
      } finally {
        await prisma.device.update({
          where: {
            id: recorderChildDeviceId,
          },
          data: {
            gatewayDeviceId:
              recorderDeviceId,
          },
        });
      }
    },
  );

  it(
    'keeps a no-HDD recorder ONLINE/HEALTHY while surfacing collection quality (V2)',
    async () => {
      // The Speco adapter reports the NVR itself: authentication + core
      // collection succeeded, one optional source failed, and there is no
      // HDD installed. None of that may degrade the recorder.
      const response = await request(app.getHttpServer())
        .post(`${API}/telemetry/ingest`)
        .set('x-device-id', recorderDeviceId)
        .set('x-device-key', recorderKey)
        .send({
          timestamp: Math.floor(Date.now() / 1000),
          status: 'online',
          model: 'N8NRL',
          firmware: '1.0.0',
          collectionState: 'PARTIAL',
          collectionIssues: [
            {
              code: 'OPTIONAL_ENRICHMENT_UNAVAILABLE',
              source: 'ADAPTER',
              detail: 'cameraFirmware:c1: errorCode=536870962',
            },
          ],
          capabilities: {
            storage: {
              supported: true,
              present: false,
              state: 'NOT_INSTALLED',
            },
            recording: { state: 'NOT_AVAILABLE_NO_STORAGE' },
          },
        })
        .expect(201);

      expect(response.body.connectivity.state).toBe('ONLINE');
      expect(response.body.connectivity.linkState).toBe('ONLINE');
      expect(response.body.health.state).toBe('HEALTHY');
      expect(response.body.health.reasons).toEqual([]);
      expect(response.body.collection.state).toBe('PARTIAL');
      expect(
        response.body.collection.issues.map(
          (issue: { code: string }) => issue.code,
        ),
      ).toEqual(['OPTIONAL_ENRICHMENT_UNAVAILABLE']);
      expect(response.body.capabilities.storage.state).toBe(
        'NOT_INSTALLED',
      );
      expect(response.body.capabilities.storage.present).toBe(false);
      expect(response.body.capabilities.recording.state).toBe(
        'NOT_AVAILABLE_NO_STORAGE',
      );

      // No incident of any kind for the recorder from collection quality.
      const recorderIncident = await prisma.alert.findFirst({
        where: {
          deviceId: recorderDeviceId,
          status: 'OPEN',
        },
      });
      expect(recorderIncident).toBeNull();

      // Collection issues are visible in the overview as diagnostics only.
      const overview = await request(app.getHttpServer())
        .get(`${API}/operations/overview`)
        .set(bearer(adminToken))
        .expect(200);

      expect(
        overview.body.summary.collectionIssues,
      ).toBeGreaterThanOrEqual(1);
    },
  );

  it(
    'reconciles a reported COMPLETE + optional enrichment gap to PARTIAL (real-lab shape)',
    async () => {
      // The live Speco N8NRL posts collectionState COMPLETE together with
      // per-channel OPTIONAL_ENRICHMENT_UNAVAILABLE issues (queryIPChlInfo
      // unsupported). The engine must reconcile that to PARTIAL without
      // touching connectivity/health or opening an incident.
      const response = await request(app.getHttpServer())
        .post(`${API}/telemetry/ingest`)
        .set('x-device-id', recorderDeviceId)
        .set('x-device-key', recorderKey)
        .send({
          timestamp: Math.floor(Date.now() / 1000),
          status: 'online',
          model: 'N8NRL',
          firmware: '1.0.0',
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
          ],
        })
        .expect(201);

      expect(response.body.connectivity.state).toBe('ONLINE');
      expect(response.body.connectivity.linkState).toBe('ONLINE');
      expect(response.body.health.state).toBe('HEALTHY');
      expect(response.body.health.reasons).toEqual([]);
      expect(response.body.collection.state).toBe('PARTIAL');
      expect(
        response.body.collection.issues.map(
          (issue: { code: string }) => issue.code,
        ),
      ).toEqual([
        'OPTIONAL_ENRICHMENT_UNAVAILABLE',
        'OPTIONAL_ENRICHMENT_UNAVAILABLE',
      ]);

      const recorderIncident = await prisma.alert.findFirst({
        where: {
          deviceId: recorderDeviceId,
          status: 'OPEN',
        },
      });
      expect(recorderIncident).toBeNull();
    },
  );

  it('rejects missing, invalid and cross-device credentials', async () => {
    const payload = telemetryPayload();

    await request(app.getHttpServer())
      .post(`${API}/telemetry/ingest`)
      .send(payload)
      .expect(401);

    await request(app.getHttpServer())
      .post(`${API}/telemetry/ingest`)
      .set('x-device-id', localDeviceId)
      .set('x-device-key', `${deviceKey}-wrong`)
      .send(payload)
      .expect(401);

    await request(app.getHttpServer())
      .post(`${API}/telemetry/ingest`)
      .set('x-device-id', foreignDeviceId)
      .set('x-device-key', deviceKey)
      .send(payload)
      .expect(401);
  });

  it('persists degraded telemetry and opens a warning alert', async () => {
    const response = await request(app.getHttpServer())
      .post(`${API}/telemetry/ingest`)
      .set('x-device-id', localDeviceId)
      .set('x-device-key', deviceKey)
      .send(
        telemetryPayload({
          status: 'warning',
          temperatureC: 82,
          storageUsedPct: 96,
        }),
      )
      .expect(201);

    // Compatibility alias still collapses the health degradation.
    expect(response.body.connectivity.state).toBe('DEGRADED');
    // The three dimensions are now independent: the link is fine, only
    // operational health is degraded.
    expect(response.body.connectivity.linkState).toBe('ONLINE');
    expect(response.body.health.state).toBe('DEGRADED');

    const snapshot = await prisma.deviceTelemetrySnapshot.findUniqueOrThrow({
      where: {
        deviceId: localDeviceId,
      },
    });

    expect(snapshot.temperatureC).toBe(82);

    expect(snapshot.storageUsedPct).toBe(96);

    const openAlert = await prisma.alert.findFirst({
      where: {
        deviceId: localDeviceId,
        status: 'OPEN',
        severity: 'WARNING',
        connectivityState: 'DEGRADED',
      },
    });

    expect(openAlert).not.toBeNull();

    const event = await prisma.deviceConnectivityEvent.findFirst({
      where: {
        deviceId: localDeviceId,
        currentState: 'DEGRADED',
      },
    });

    expect(event).not.toBeNull();
  });

  it('returns persistent telemetry through authenticated device routes', async () => {
    const response = await request(app.getHttpServer())
      .get(`${API}/devices/${localDeviceId}/telemetry`)
      .set(bearer(adminToken))
      .expect(200);

    expect(response.body.connectivity.state).toBe('DEGRADED');

    expect(response.body.telemetry.model).toBe('Local Test Camera');

    await request(app.getHttpServer())
      .get(`${API}/devices/${foreignDeviceId}/telemetry`)
      .set(bearer(adminToken))
      .expect(404);
  });

  it('resolves the warning after a healthy heartbeat', async () => {
    const response = await request(app.getHttpServer())
      .post(`${API}/telemetry/ingest`)
      .set('x-device-id', localDeviceId)
      .set('x-device-key', deviceKey)
      .send(
        telemetryPayload({
          status: 'online',
          temperatureC: 44,
          storageUsedPct: 52,
        }),
      )
      .expect(201);

    expect(response.body.connectivity.state).toBe('ONLINE');

    const resolvedAlert = await prisma.alert.findFirst({
      where: {
        deviceId: localDeviceId,
        status: 'RESOLVED',
        connectivityState: 'ONLINE',
      },
    });

    expect(resolvedAlert).not.toBeNull();

    const onlineEvent = await prisma.deviceConnectivityEvent.findFirst({
      where: {
        deviceId: localDeviceId,
        currentState: 'ONLINE',
      },
    });

    expect(onlineEvent).not.toBeNull();
  });

  it('invalidates the previous key after rotation', async () => {
    const oldKey = deviceKey;

    const rotation = await request(app.getHttpServer())
      .post(`${API}/devices/${localDeviceId}/ingestion-key/rotate`)
      .set(bearer(adminToken))
      .expect(201);

    const newKey = rotation.body.deviceKey;

    expect(newKey).not.toBe(oldKey);

    await request(app.getHttpServer())
      .post(`${API}/telemetry/ingest`)
      .set('x-device-id', localDeviceId)
      .set('x-device-key', oldKey)
      .send(telemetryPayload())
      .expect(401);

    await request(app.getHttpServer())
      .post(`${API}/telemetry/ingest`)
      .set('x-device-id', localDeviceId)
      .set('x-device-key', newKey)
      .send(telemetryPayload())
      .expect(201);

    deviceKey = newKey;
  });
});
