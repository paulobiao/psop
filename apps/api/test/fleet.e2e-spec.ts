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
  'FleetIntegrationPassword123!';

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
    Authorization:
      `Bearer ${token}`,
  };
}

describe(
  'PSOP device fleet integration',
  () => {
    let app: INestApplication;

    const runId =
      randomUUID().slice(0, 8);

    let organizationAId: string;
    let organizationBId: string;
    let siteAId: string;
    let siteBId: string;
    let adminAEmail: string;
    let viewerAEmail: string;
    let localDeviceId: string;
    let foreignDeviceId: string;

    const organizationIds:
      string[] = [];

    beforeAll(async () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET =
        'fleet-access-secret-that-is-long-enough';
      process.env.JWT_REFRESH_SECRET =
        'fleet-refresh-secret-that-is-long-enough';
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
      process.env.AWS_REGION =
        'us-east-1';
      process.env.TELEMETRY_DEMO_MODE =
        'true';

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

      const organizationA =
        await prisma.organization.create({
          data: {
            name:
              `Fleet Organization A ${runId}`,
            slug:
              `fleet-a-${runId}`,
          },
        });

      const organizationB =
        await prisma.organization.create({
          data: {
            name:
              `Fleet Organization B ${runId}`,
            slug:
              `fleet-b-${runId}`,
          },
        });

      organizationAId =
        organizationA.id;

      organizationBId =
        organizationB.id;

      organizationIds.push(
        organizationAId,
        organizationBId,
      );

      const [siteA, siteB] =
        await Promise.all([
          prisma.site.create({
            data: {
              organizationId:
                organizationAId,
              name:
                'Fleet Site A',
              code:
                `FLEET-A-${runId}`,
              timezone:
                'America/New_York',
            },
          }),
          prisma.site.create({
            data: {
              organizationId:
                organizationBId,
              name:
                'Fleet Site B',
              code:
                `FLEET-B-${runId}`,
              timezone:
                'America/New_York',
            },
          }),
        ]);

      siteAId = siteA.id;
      siteBId = siteB.id;

      adminAEmail =
        `fleet-admin-${runId}@psop.test`;

      viewerAEmail =
        `fleet-viewer-${runId}@psop.test`;

      const passwordHash =
        await hash(PASSWORD, 12);

      await Promise.all([
        prisma.user.create({
          data: {
            organizationId:
              organizationAId,
            name:
              'Fleet Administrator',
            email: adminAEmail,
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
              'Fleet Viewer',
            email: viewerAEmail,
            passwordHash,
            role: 'VIEWER',
            mustChangePassword:
              false,
          },
        }),
      ]);

      const [localDevice, foreignDevice] =
        await Promise.all([
          prisma.device.create({
            data: {
              siteId: siteAId,
              name:
                'Local Seed Camera',
              externalId:
                `LOCAL-${runId}`,
              deviceType: 'CAMERA',
              status: 'ACTIVE',
              expectedHeartbeatInterval:
                60,
            },
          }),
          prisma.device.create({
            data: {
              siteId: siteBId,
              name:
                'Foreign Camera',
              externalId:
                `FOREIGN-${runId}`,
              deviceType: 'CAMERA',
              status: 'ACTIVE',
              expectedHeartbeatInterval:
                60,
            },
          }),
        ]);

      localDeviceId =
        localDevice.id;

      foreignDeviceId =
        foreignDevice.id;
    });

    afterAll(async () => {
      const filter = {
        in: organizationIds,
      };

      await prisma.auditLog.deleteMany({
        where: {
          organizationId: filter,
        },
      });

      await prisma.userSession.deleteMany({
        where: {
          organizationId: filter,
        },
      });

      await prisma.authChallenge.deleteMany({
        where: {
          organizationId: filter,
        },
      });

      await prisma.alert.deleteMany({
        where: {
          device: {
            site: {
              organizationId: filter,
            },
          },
        },
      });

      await prisma.device.deleteMany({
        where: {
          site: {
            organizationId: filter,
          },
        },
      });

      await prisma.user.deleteMany({
        where: {
          organizationId: filter,
        },
      });

      await prisma.site.deleteMany({
        where: {
          organizationId: filter,
        },
      });

      await prisma.organization
        .deleteMany({
          where: {
            id: filter,
          },
        });

      await prisma.$disconnect();
      await app.close();
    });

    async function login(
      email: string,
    ): Promise<string> {
      const response = await request(
        app.getHttpServer(),
      )
        .post(`${API}/auth/login`)
        .send({
          email,
          password: PASSWORD,
        })
        .expect(200);

      return (
        response.body as LoginBody
      ).accessToken;
    }

    it(
      'creates and updates a device inside its organization',
      async () => {
        const token =
          await login(adminAEmail);

        const created =
          await request(
            app.getHttpServer(),
          )
            .post(`${API}/devices`)
            .set(bearer(token))
            .send({
              siteId: siteAId,
              name:
                'Fleet Integration Camera',
              externalId:
                `CAM-${runId}`,
              deviceType: 'CAMERA',
              manufacturer: 'Lorex',
              model: 'L871T8-Z',
              expectedHeartbeatInterval:
                30,
              status: 'ACTIVE',
            })
            .expect(201);

        expect(
          created.body.siteId,
        ).toBe(siteAId);

        const updated =
          await request(
            app.getHttpServer(),
          )
            .patch(
              `${API}/devices/${created.body.id}`,
            )
            .set(bearer(token))
            .send({
              name:
                'Updated Fleet Camera',
              expectedHeartbeatInterval:
                45,
            })
            .expect(200);

        expect(updated.body.name).toBe(
          'Updated Fleet Camera',
        );

        expect(
          updated.body
            .expectedHeartbeatInterval,
        ).toBe(45);
      },
    );

    it(
      'blocks cross-organization access and site assignment',
      async () => {
        const token =
          await login(adminAEmail);

        await request(
          app.getHttpServer(),
        )
          .post(`${API}/devices`)
          .set(bearer(token))
          .send({
            siteId: siteBId,
            name:
              'Cross Tenant Camera',
            externalId:
              `CROSS-${runId}`,
            deviceType: 'CAMERA',
          })
          .expect(404);

        await request(
          app.getHttpServer(),
        )
          .patch(
            `${API}/devices/${localDeviceId}`,
          )
          .set(bearer(token))
          .send({
            siteId: siteBId,
          })
          .expect(404);

        await request(
          app.getHttpServer(),
        )
          .get(
            `${API}/devices/${foreignDeviceId}`,
          )
          .set(bearer(token))
          .expect(404);

        await request(
          app.getHttpServer(),
        )
          .patch(
            `${API}/devices/${foreignDeviceId}`,
          )
          .set(bearer(token))
          .send({
            name:
              'Unauthorized Update',
          })
          .expect(404);

        await request(
          app.getHttpServer(),
        )
          .delete(
            `${API}/devices/${foreignDeviceId}`,
          )
          .set(bearer(token))
          .expect(404);
      },
    );

    it(
      'maps devices to an organization-owned gateway',
      async () => {
        const token =
          await login(adminAEmail);

        const gateway =
          await request(
            app.getHttpServer(),
          )
            .post(`${API}/devices`)
            .set(bearer(token))
            .send({
              siteId: siteAId,
              name:
                'Fleet Edge Gateway',
              externalId:
                `GATEWAY-${runId}`,
              deviceType: 'GATEWAY',
              monitoringMode: 'DIRECT',
              status: 'ACTIVE',
            })
            .expect(201);

        const child =
          await request(
            app.getHttpServer(),
          )
            .post(`${API}/devices`)
            .set(bearer(token))
            .send({
              siteId: siteAId,
              name:
                'Gateway Camera',
              externalId:
                `GATEWAY-CAM-${runId}`,
              deviceType: 'CAMERA',
              monitoringMode: 'VIA_GATEWAY',
              gatewayDeviceId:
                gateway.body.id,
              status: 'ACTIVE',
            })
            .expect(201);

        expect(
          child.body.monitoringMode,
        ).toBe('VIA_GATEWAY');

        expect(
          child.body.gatewayDeviceId,
        ).toBe(gateway.body.id);

        const inventoryOnly =
          await request(
            app.getHttpServer(),
          )
            .patch(
              `${API}/devices/${child.body.id}`,
            )
            .set(bearer(token))
            .send({
              monitoringMode:
                'INVENTORY_ONLY',
            })
            .expect(200);

        expect(
          inventoryOnly.body
            .gatewayDeviceId,
        ).toBeNull();

        await request(
          app.getHttpServer(),
        )
          .post(`${API}/devices`)
          .set(bearer(token))
          .send({
            siteId: siteAId,
            name:
              'Invalid Gateway Camera',
            externalId:
              `INVALID-GATEWAY-${runId}`,
            deviceType: 'CAMERA',
            monitoringMode:
              'VIA_GATEWAY',
            gatewayDeviceId:
              localDeviceId,
          })
          .expect(400);

        await request(
          app.getHttpServer(),
        )
          .post(`${API}/devices`)
          .set(bearer(token))
          .send({
            siteId: siteAId,
            name:
              'Foreign Gateway Camera',
            externalId:
              `FOREIGN-GATEWAY-${runId}`,
            deviceType: 'CAMERA',
            monitoringMode:
              'VIA_GATEWAY',
            gatewayDeviceId:
              foreignDeviceId,
          })
          .expect(404);
      },
    );

    it(
      'returns honest gateway-derived status without direct child telemetry',
      async () => {
        const token =
          await login(adminAEmail);

        const gateway =
          await request(
            app.getHttpServer(),
          )
            .post(`${API}/devices`)
            .set(bearer(token))
            .send({
              siteId: siteAId,
              name:
                'Derived Status Gateway',
              externalId:
                `DERIVED-GATEWAY-${runId}`,
              deviceType: 'GATEWAY',
              monitoringMode: 'DIRECT',
              status: 'ACTIVE',
            })
            .expect(201);

        const child =
          await request(
            app.getHttpServer(),
          )
            .post(`${API}/devices`)
            .set(bearer(token))
            .send({
              siteId: siteAId,
              name:
                'Derived Status Camera',
              externalId:
                `DERIVED-CAM-${runId}`,
              deviceType: 'CAMERA',
              monitoringMode:
                'VIA_GATEWAY',
              gatewayDeviceId:
                gateway.body.id,
              status: 'ACTIVE',
            })
            .expect(201);

        const overview =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/operations/overview`,
            )
            .set(bearer(token))
            .expect(200);

        expect(
          overview.body.fleet.some(
            (item: {
              device: {
                id: string;
              };
            }) =>
              item.device.id ===
              child.body.id,
          ),
        ).toBe(false);

        const derived =
          overview.body.gatewayManaged.find(
            (item: {
              device: {
                id: string;
              };
            }) =>
              item.device.id ===
              child.body.id,
          );

        expect(derived).toBeDefined();

        expect(
          derived.monitoring
            .individualVerification,
        ).toBe('NOT_VERIFIED');

        expect(
          derived.gateway.id,
        ).toBe(gateway.body.id);

        expect(
          derived.gateway.connectivity.state,
        ).toBeDefined();

        expect(
          overview.body.summary
            .gatewayManaged,
        ).toBeGreaterThanOrEqual(1);

        await request(
          app.getHttpServer(),
        )
          .patch(
            `${API}/devices/${child.body.id}`,
          )
          .set(bearer(token))
          .send({
            monitoringMode:
              'INVENTORY_ONLY',
          })
          .expect(200);
      },
    );

    it(
      'resolves direct alerts when equipment moves behind a gateway',
      async () => {
        const token =
          await login(adminAEmail);

        const gateway =
          await request(
            app.getHttpServer(),
          )
            .post(`${API}/devices`)
            .set(bearer(token))
            .send({
              siteId: siteAId,
              name:
                'Alert Transition Gateway',
              externalId:
                `ALERT-GATEWAY-${runId}`,
              deviceType: 'GATEWAY',
              monitoringMode: 'DIRECT',
              status: 'ACTIVE',
            })
            .expect(201);

        const camera =
          await request(
            app.getHttpServer(),
          )
            .post(`${API}/devices`)
            .set(bearer(token))
            .send({
              siteId: siteAId,
              name:
                'Alert Transition Camera',
              externalId:
                `ALERT-CAM-${runId}`,
              deviceType: 'CAMERA',
              monitoringMode: 'DIRECT',
              status: 'ACTIVE',
            })
            .expect(201);

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/devices/${camera.body.id}/demo-state`,
          )
          .set(bearer(token))
          .send({
            state: 'OFFLINE',
          })
          .expect(201);

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/devices/telemetry/evaluate`,
          )
          .set(bearer(token))
          .expect(201);

        const before =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/alerts?deviceId=${camera.body.id}`,
            )
            .set(bearer(token))
            .expect(200);

        expect(
          before.body.some(
            (alert: {
              status: string;
            }) =>
              alert.status === 'OPEN',
          ),
        ).toBe(true);

        await request(
          app.getHttpServer(),
        )
          .patch(
            `${API}/devices/${camera.body.id}`,
          )
          .set(bearer(token))
          .send({
            monitoringMode:
              'VIA_GATEWAY',
            gatewayDeviceId:
              gateway.body.id,
          })
          .expect(200);

        const after =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/alerts?deviceId=${camera.body.id}`,
            )
            .set(bearer(token))
            .expect(200);

        expect(
          after.body.some(
            (alert: {
              status: string;
            }) =>
              alert.status === 'OPEN',
          ),
        ).toBe(false);

        expect(
          after.body.some(
            (alert: {
              status: string;
              connectivityState:
                string | null;
            }) =>
              alert.status ===
                'RESOLVED' &&
              alert.connectivityState ===
                'NOT_DIRECTLY_MONITORED',
          ),
        ).toBe(true);
      },
    );

    it(
      'prevents viewers from changing inventory',
      async () => {
        const token =
          await login(viewerAEmail);

        await request(
          app.getHttpServer(),
        )
          .post(`${API}/devices`)
          .set(bearer(token))
          .send({
            siteId: siteAId,
            name:
              'Viewer Camera',
            externalId:
              `VIEWER-${runId}`,
            deviceType: 'CAMERA',
          })
          .expect(403);
      },
    );

    it(
      'runs controlled telemetry states without AWS',
      async () => {
        const token =
          await login(adminAEmail);

        const status =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/devices/demo/status`,
            )
            .set(bearer(token))
            .expect(200);

        expect(
          status.body.enabled,
        ).toBe(true);

        const degraded =
          await request(
            app.getHttpServer(),
          )
            .post(
              `${API}/devices/${localDeviceId}/demo-state`,
            )
            .set(bearer(token))
            .send({
              state: 'DEGRADED',
            })
            .expect(201);

        expect(
          degraded.body
            .connectivity.state,
        ).toBe('DEGRADED');

        expect(
          degraded.body
            .connectivity.reasons,
        ).toEqual(
          expect.arrayContaining([
            'REPORTED_STATUS_NOT_HEALTHY',
            'HIGH_TEMPERATURE',
            'HIGH_STORAGE_USAGE',
          ]),
        );

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/devices/telemetry/evaluate`,
          )
          .set(bearer(token))
          .expect(201);

        const alerts =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/alerts?deviceId=${localDeviceId}`,
            )
            .set(bearer(token))
            .expect(200);

        expect(
          alerts.body.some(
            (alert: {
              status: string;
              severity: string;
              connectivityState:
                string;
            }) =>
              alert.status === 'OPEN' &&
              alert.severity === 'WARNING' &&
              alert.connectivityState ===
                'DEGRADED',
          ),
        ).toBe(true);

        const online =
          await request(
            app.getHttpServer(),
          )
            .post(
              `${API}/devices/${localDeviceId}/demo-state`,
            )
            .set(bearer(token))
            .send({
              state: 'ONLINE',
            })
            .expect(201);

        expect(
          online.body
            .connectivity.state,
        ).toBe('ONLINE');

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/devices/telemetry/evaluate`,
          )
          .set(bearer(token))
          .expect(201);

        const resolved =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/alerts?deviceId=${localDeviceId}`,
            )
            .set(bearer(token))
            .expect(200);

        expect(
          resolved.body.some(
            (alert: {
              status: string;
              connectivityState:
                string | null;
            }) =>
              alert.status ===
                'RESOLVED' &&
              alert.connectivityState ===
                'ONLINE',
          ),
        ).toBe(true);

        const events =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/devices/${localDeviceId}/connectivity-events`,
            )
            .set(bearer(token))
            .expect(200);

        expect(
          events.body.events.map(
            (event: {
              current_state:
                string;
            }) =>
              event.current_state,
          ),
        ).toEqual(
          expect.arrayContaining([
            'DEGRADED',
            'ONLINE',
          ]),
        );

        const overview =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/operations/overview`,
            )
            .set(bearer(token))
            .expect(200);

        const incident =
          overview.body.recentIncidents.find(
            (item: {
              deviceId: string;
            }) =>
              item.deviceId ===
              localDeviceId,
          );

        expect(incident).toBeDefined();
        expect(incident.status).toBe(
          'RESOLVED',
        );
        expect(
          incident.monitoringSource,
        ).toBe('DIRECT');
        expect(
          incident.durationSeconds,
        ).toBeGreaterThanOrEqual(0);
        expect(
          incident.startedAt,
        ).toBeDefined();
        expect(
          incident.endedAt,
        ).toBeDefined();
      },
    );

    it(
      'enforces roles and tenant isolation for demo controls',
      async () => {
        const viewerToken =
          await login(viewerAEmail);

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/devices/${localDeviceId}/demo-state`,
          )
          .set(
            bearer(viewerToken),
          )
          .send({
            state: 'OFFLINE',
          })
          .expect(403);

        const adminToken =
          await login(adminAEmail);

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/devices/${foreignDeviceId}/demo-state`,
          )
          .set(
            bearer(adminToken),
          )
          .send({
            state: 'ONLINE',
          })
          .expect(404);
      },
    );

    it(
      'returns only organization-owned devices',
      async () => {
        const token =
          await login(adminAEmail);

        const response =
          await request(
            app.getHttpServer(),
          )
            .get(`${API}/devices`)
            .set(bearer(token))
            .expect(200);

        expect(
          response.body.some(
            (device: {
              id: string;
            }) =>
              device.id ===
              foreignDeviceId,
          ),
        ).toBe(false);

        expect(
          response.body.some(
            (device: {
              id: string;
            }) =>
              device.id ===
              localDeviceId,
          ),
        ).toBe(true);
      },
    );
  },
);
