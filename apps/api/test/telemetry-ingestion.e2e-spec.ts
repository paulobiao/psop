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
import {
  PrismaClient,
} from '../generated/prisma/client.js';
import { AppModule } from '../src/app.module.js';

const DATABASE_URL =
  process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required for integration tests',
  );
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: DATABASE_URL,
  }),
});

const API = '/api/v1';

const PASSWORD =
  'LocalTelemetryPassword123!';

interface LoginBody {
  stage: 'AUTHENTICATED';
  accessToken: string;
}

function bearer(
  token: string,
): {
  Authorization: string;
} {
  return {
    Authorization: `Bearer ${token}`,
  };
}

describe(
  'PSOP local telemetry ingestion',
  () => {
    let app: INestApplication;

    const runId =
      randomUUID().slice(0, 8);

    const organizationIds: string[] = [];

    let organizationAId: string;
    let organizationBId: string;
    let siteAId: string;
    let siteBId: string;
    let localDeviceId: string;
    let foreignDeviceId: string;
    let adminEmail: string;
    let viewerEmail: string;
    let adminToken: string;
    let viewerToken: string;
    let deviceKey: string;

    beforeAll(async () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET =
        'local-telemetry-access-secret-long-enough';
      process.env.JWT_REFRESH_SECRET =
        'local-telemetry-refresh-secret-long-enough';
      process.env.JWT_EXPIRES_SECONDS =
        '900';
      process.env
        .JWT_REFRESH_EXPIRES_SECONDS =
        '3600';
      process.env.MFA_ENCRYPTION_KEY =
        '0123456789abcdef0123456789abcdef' +
        '0123456789abcdef0123456789abcdef';
      process.env
        .CONNECTIVITY_MONITOR_ENABLED =
        'false';
      process.env.TELEMETRY_DEMO_MODE =
        'false';
      process.env
        .LOCAL_TELEMETRY_INGESTION_ENABLED =
        'true';
      process.env.AWS_REGION =
        'us-east-1';

      const moduleRef =
        await Test
          .createTestingModule({
            imports: [AppModule],
          })
          .compile();

      app =
        moduleRef.createNestApplication();

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

      const [
        organizationA,
        organizationB,
      ] = await Promise.all([
        prisma.organization.create({
          data: {
            name:
              `Local Telemetry A ${runId}`,
            slug:
              `local-telemetry-a-${runId}`,
          },
        }),
        prisma.organization.create({
          data: {
            name:
              `Local Telemetry B ${runId}`,
            slug:
              `local-telemetry-b-${runId}`,
          },
        }),
      ]);

      organizationAId =
        organizationA.id;
      organizationBId =
        organizationB.id;

      organizationIds.push(
        organizationAId,
        organizationBId,
      );

      const [
        siteA,
        siteB,
      ] = await Promise.all([
        prisma.site.create({
          data: {
            organizationId:
              organizationAId,
            name:
              'Local Telemetry Site A',
            code:
              `LOCAL-A-${runId}`,
            timezone:
              'America/New_York',
          },
        }),
        prisma.site.create({
          data: {
            organizationId:
              organizationBId,
            name:
              'Local Telemetry Site B',
            code:
              `LOCAL-B-${runId}`,
            timezone:
              'America/New_York',
          },
        }),
      ]);

      siteAId = siteA.id;
      siteBId = siteB.id;

      adminEmail =
        `local-admin-${runId}@psop.test`;

      viewerEmail =
        `local-viewer-${runId}@psop.test`;

      const passwordHash =
        await hash(PASSWORD, 12);

      await Promise.all([
        prisma.user.create({
          data: {
            organizationId:
              organizationAId,
            name:
              'Local Telemetry Admin',
            email:
              adminEmail,
            passwordHash,
            role: 'ADMIN',
            mustChangePassword:
              false,
          },
        }),
        prisma.user.create({
          data: {
            organizationId:
              organizationAId,
            name:
              'Local Telemetry Viewer',
            email:
              viewerEmail,
            passwordHash,
            role: 'VIEWER',
            mustChangePassword:
              false,
          },
        }),
      ]);

      const [
        localDevice,
        foreignDevice,
      ] = await Promise.all([
        prisma.device.create({
          data: {
            siteId: siteAId,
            name:
              'Local Camera A',
            externalId:
              `LOCAL-CAM-A-${runId}`,
            deviceType:
              'CAMERA',
            status:
              'ACTIVE',
            expectedHeartbeatInterval:
              60,
          },
        }),
        prisma.device.create({
          data: {
            siteId: siteBId,
            name:
              'Foreign Camera B',
            externalId:
              `LOCAL-CAM-B-${runId}`,
            deviceType:
              'CAMERA',
            status:
              'ACTIVE',
            expectedHeartbeatInterval:
              60,
          },
        }),
      ]);

      localDeviceId =
        localDevice.id;
      foreignDeviceId =
        foreignDevice.id;

      adminToken =
        await login(adminEmail);

      viewerToken =
        await login(viewerEmail);
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

      await prisma
        .deviceConnectivityEvent
        .deleteMany({
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

      await prisma
        .deviceTelemetrySnapshot
        .deleteMany({
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

      await prisma
        .deviceIngestionCredential
        .deleteMany({
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

    async function login(
      email: string,
    ): Promise<string> {
      const response =
        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/auth/login`,
          )
          .send({
            email,
            password: PASSWORD,
          })
          .expect(200);

      return (
        response.body as LoginBody
      ).accessToken;
    }

    function telemetryPayload(
      overrides:
        Record<string, unknown> = {},
    ) {
      return {
        timestamp:
          Math.floor(
            Date.now() / 1000,
          ),
        status: 'online',
        temperatureC: 44,
        bitrateKbps: 4200,
        storageUsedPct: 52,
        uptimeSeconds: 7200,
        model:
          'Local Test Camera',
        firmware:
          'test-1.0.0',
        ...overrides,
      };
    }

    it(
      'rotates a one-time key with role and tenant isolation',
      async () => {
        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/devices/${localDeviceId}/ingestion-key/rotate`,
          )
          .set(
            bearer(viewerToken),
          )
          .expect(403);

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/devices/${foreignDeviceId}/ingestion-key/rotate`,
          )
          .set(
            bearer(adminToken),
          )
          .expect(404);

        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              `${API}/devices/${localDeviceId}/ingestion-key/rotate`,
            )
            .set(
              bearer(adminToken),
            )
            .expect(201);

        deviceKey =
          response.body.deviceKey;

        expect(deviceKey).toMatch(
          /^psop_cam_[A-Za-z0-9_-]{43}$/,
        );

        const credential =
          await prisma
            .deviceIngestionCredential
            .findUniqueOrThrow({
              where: {
                deviceId:
                  localDeviceId,
              },
            });

        expect(
          credential.keyHash,
        ).not.toContain(
          deviceKey,
        );

        const auditLogs =
          await prisma.auditLog.findMany({
            where: {
              organizationId:
                organizationAId,
            },
          });

        expect(
          JSON.stringify(auditLogs),
        ).not.toContain(
          deviceKey,
        );
      },
    );

    it(
      'rejects missing, invalid and cross-device credentials',
      async () => {
        const payload =
          telemetryPayload();

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/telemetry/ingest`,
          )
          .send(payload)
          .expect(401);

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/telemetry/ingest`,
          )
          .set(
            'x-device-id',
            localDeviceId,
          )
          .set(
            'x-device-key',
            `${deviceKey}-wrong`,
          )
          .send(payload)
          .expect(401);

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/telemetry/ingest`,
          )
          .set(
            'x-device-id',
            foreignDeviceId,
          )
          .set(
            'x-device-key',
            deviceKey,
          )
          .send(payload)
          .expect(401);
      },
    );

    it(
      'persists degraded telemetry and opens a warning alert',
      async () => {
        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              `${API}/telemetry/ingest`,
            )
            .set(
              'x-device-id',
              localDeviceId,
            )
            .set(
              'x-device-key',
              deviceKey,
            )
            .send(
              telemetryPayload({
                status:
                  'warning',
                temperatureC:
                  82,
                storageUsedPct:
                  96,
              }),
            )
            .expect(201);

        expect(
          response.body
            .connectivity.state,
        ).toBe('DEGRADED');

        const snapshot =
          await prisma
            .deviceTelemetrySnapshot
            .findUniqueOrThrow({
              where: {
                deviceId:
                  localDeviceId,
              },
            });

        expect(
          snapshot.temperatureC,
        ).toBe(82);

        expect(
          snapshot.storageUsedPct,
        ).toBe(96);

        const openAlert =
          await prisma.alert.findFirst({
            where: {
              deviceId:
                localDeviceId,
              status:
                'OPEN',
              severity:
                'WARNING',
              connectivityState:
                'DEGRADED',
            },
          });

        expect(openAlert)
          .not.toBeNull();

        const event =
          await prisma
            .deviceConnectivityEvent
            .findFirst({
              where: {
                deviceId:
                  localDeviceId,
                currentState:
                  'DEGRADED',
              },
            });

        expect(event)
          .not.toBeNull();
      },
    );

    it(
      'returns persistent telemetry through authenticated device routes',
      async () => {
        const response =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/devices/${localDeviceId}/telemetry`,
            )
            .set(
              bearer(adminToken),
            )
            .expect(200);

        expect(
          response.body
            .connectivity.state,
        ).toBe('DEGRADED');

        expect(
          response.body
            .telemetry.model,
        ).toBe(
          'Local Test Camera',
        );

        await request(
          app.getHttpServer(),
        )
          .get(
            `${API}/devices/${foreignDeviceId}/telemetry`,
          )
          .set(
            bearer(adminToken),
          )
          .expect(404);
      },
    );

    it(
      'resolves the warning after a healthy heartbeat',
      async () => {
        const response =
          await request(
            app.getHttpServer(),
          )
            .post(
              `${API}/telemetry/ingest`,
            )
            .set(
              'x-device-id',
              localDeviceId,
            )
            .set(
              'x-device-key',
              deviceKey,
            )
            .send(
              telemetryPayload({
                status:
                  'online',
                temperatureC:
                  44,
                storageUsedPct:
                  52,
              }),
            )
            .expect(201);

        expect(
          response.body
            .connectivity.state,
        ).toBe('ONLINE');

        const resolvedAlert =
          await prisma.alert.findFirst({
            where: {
              deviceId:
                localDeviceId,
              status:
                'RESOLVED',
              connectivityState:
                'ONLINE',
            },
          });

        expect(resolvedAlert)
          .not.toBeNull();

        const onlineEvent =
          await prisma
            .deviceConnectivityEvent
            .findFirst({
              where: {
                deviceId:
                  localDeviceId,
                currentState:
                  'ONLINE',
              },
            });

        expect(onlineEvent)
          .not.toBeNull();
      },
    );

    it(
      'invalidates the previous key after rotation',
      async () => {
        const oldKey =
          deviceKey;

        const rotation =
          await request(
            app.getHttpServer(),
          )
            .post(
              `${API}/devices/${localDeviceId}/ingestion-key/rotate`,
            )
            .set(
              bearer(adminToken),
            )
            .expect(201);

        const newKey =
          rotation.body.deviceKey;

        expect(newKey)
          .not.toBe(oldKey);

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/telemetry/ingest`,
          )
          .set(
            'x-device-id',
            localDeviceId,
          )
          .set(
            'x-device-key',
            oldKey,
          )
          .send(
            telemetryPayload(),
          )
          .expect(401);

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/telemetry/ingest`,
          )
          .set(
            'x-device-id',
            localDeviceId,
          )
          .set(
            'x-device-key',
            newKey,
          )
          .send(
            telemetryPayload(),
          )
          .expect(201);

        deviceKey = newKey;
      },
    );
  },
);
