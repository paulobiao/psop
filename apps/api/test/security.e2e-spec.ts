import {
  type INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from 'bcryptjs';
import {
  createHmac,
  randomUUID,
} from 'node:crypto';
import request from 'supertest';
import type { Response } from 'supertest';
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

const adapter = new PrismaPg({
  connectionString: DATABASE_URL,
});

const prisma = new PrismaClient({
  adapter,
});

const API = '/api/v1';

const TEMPORARY_PASSWORD =
  'TemporaryPassword123!';

const PERMANENT_PASSWORD =
  'PermanentPassword456!';

const ADMIN_PASSWORD =
  'AdministratorPassword123!';

const VIEWER_PASSWORD =
  'ViewerPassword123!';

interface AuthenticatedBody {
  stage: 'AUTHENTICATED';
  accessToken: string;
  user: {
    id: string;
    organizationId: string;
    name: string;
    email: string;
    role: 'ADMIN' | 'OPERATOR' | 'VIEWER';
    mustChangePassword: boolean;
    mfaEnabled: boolean;
  };
}

interface ChallengeBody {
  stage:
    | 'PASSWORD_CHANGE_REQUIRED'
    | 'MFA_REQUIRED';
  challengeToken: string;
  user: {
    name: string;
    email: string;
  };
}

interface TestIdentity {
  id: string;
  email: string;
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

function getRefreshCookie(
  response: Response,
): string {
  const rawHeader =
    response.headers['set-cookie'];

  const values = Array.isArray(rawHeader)
    ? rawHeader
    : rawHeader
      ? [rawHeader]
      : [];

  const value = values.find(
    (item) =>
      item.startsWith(
        'psop.refreshToken=',
      ),
  );

  expect(value).toBeDefined();

  return value!.split(';')[0];
}

function hasRefreshCookie(
  response: Response,
): boolean {
  const rawHeader =
    response.headers['set-cookie'];

  const values = Array.isArray(rawHeader)
    ? rawHeader
    : rawHeader
      ? [rawHeader]
      : [];

  return values.some(
    (item) =>
      item.startsWith(
        'psop.refreshToken=',
      ),
  );
}

function base32Decode(
  value: string,
): Buffer {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  const normalized = value
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/\s/g, '');

  let bits = '';

  for (const character of normalized) {
    const index =
      alphabet.indexOf(character);

    if (index < 0) {
      throw new Error(
        'Invalid Base32 secret',
      );
    }

    bits += index
      .toString(2)
      .padStart(5, '0');
  }

  const bytes: number[] = [];

  for (
    let index = 0;
    index + 8 <= bits.length;
    index += 8
  ) {
    bytes.push(
      Number.parseInt(
        bits.slice(
          index,
          index + 8,
        ),
        2,
      ),
    );
  }

  return Buffer.from(bytes);
}

function currentTotp(
  secret: string,
): string {
  const counter = Math.floor(
    Date.now() / 1000 / 30,
  );

  const counterBuffer =
    Buffer.alloc(8);

  counterBuffer.writeBigUInt64BE(
    BigInt(counter),
  );

  const digest = createHmac(
    'sha1',
    base32Decode(secret),
  )
    .update(counterBuffer)
    .digest();

  const offset =
    digest[digest.length - 1] &
    0x0f;

  const value =
    digest.readUInt32BE(offset) &
    0x7fffffff;

  return String(
    value % 1_000_000,
  ).padStart(6, '0');
}

function wrongTotp(
  correctCode: string,
): string {
  const finalDigit =
    correctCode.at(-1) === '0'
      ? '1'
      : '0';

  return (
    correctCode.slice(0, -1) +
    finalDigit
  );
}

describe(
  'PSOP security integration',
  () => {
    let app: INestApplication;

    const runId =
      randomUUID().slice(0, 8);

    let organizationAId: string;
    let organizationBId: string;

    let adminA: TestIdentity;
    let adminB: TestIdentity;
    let viewerA: TestIdentity;
    let temporaryUserA: TestIdentity;

    let siteBId: string;

    const createdOrganizationIds:
      string[] = [];

    beforeAll(async () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET =
        'integration-access-secret-that-is-long-enough';
      process.env.JWT_REFRESH_SECRET =
        'integration-refresh-secret-that-is-long-enough';
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
              `Integration Organization A ${runId}`,
            slug:
              `integration-a-${runId}`,
            status: 'ACTIVE',
          },
        });

      const organizationB =
        await prisma.organization.create({
          data: {
            name:
              `Integration Organization B ${runId}`,
            slug:
              `integration-b-${runId}`,
            status: 'ACTIVE',
          },
        });

      organizationAId =
        organizationA.id;

      organizationBId =
        organizationB.id;

      createdOrganizationIds.push(
        organizationAId,
        organizationBId,
      );

      const [
        adminARecord,
        adminBRecord,
        viewerARecord,
        temporaryRecord,
      ] = await Promise.all([
        prisma.user.create({
          data: {
            organizationId:
              organizationAId,
            name:
              'Integration Admin A',
            email:
              `admin-a-${runId}@psop.test`,
            passwordHash:
              await hash(
                ADMIN_PASSWORD,
                12,
              ),
            role: 'ADMIN',
            status: 'ACTIVE',
            mustChangePassword:
              false,
          },
        }),
        prisma.user.create({
          data: {
            organizationId:
              organizationBId,
            name:
              'Integration Admin B',
            email:
              `admin-b-${runId}@psop.test`,
            passwordHash:
              await hash(
                ADMIN_PASSWORD,
                12,
              ),
            role: 'ADMIN',
            status: 'ACTIVE',
            mustChangePassword:
              false,
          },
        }),
        prisma.user.create({
          data: {
            organizationId:
              organizationAId,
            name:
              'Integration Viewer A',
            email:
              `viewer-a-${runId}@psop.test`,
            passwordHash:
              await hash(
                VIEWER_PASSWORD,
                12,
              ),
            role: 'VIEWER',
            status: 'ACTIVE',
            mustChangePassword:
              false,
          },
        }),
        prisma.user.create({
          data: {
            organizationId:
              organizationAId,
            name:
              'Temporary Integration User',
            email:
              `temporary-${runId}@psop.test`,
            passwordHash:
              await hash(
                TEMPORARY_PASSWORD,
                12,
              ),
            role: 'VIEWER',
            status: 'ACTIVE',
            mustChangePassword:
              true,
          },
        }),
      ]);

      adminA = {
        id: adminARecord.id,
        email: adminARecord.email,
      };

      adminB = {
        id: adminBRecord.id,
        email: adminBRecord.email,
      };

      viewerA = {
        id: viewerARecord.id,
        email: viewerARecord.email,
      };

      temporaryUserA = {
        id: temporaryRecord.id,
        email: temporaryRecord.email,
      };

      const siteB =
        await prisma.site.create({
          data: {
            organizationId:
              organizationBId,
            name:
              'Organization B Site',
            code:
              `ORG-B-${runId}`,
            timezone:
              'America/New_York',
            status: 'ACTIVE',
          },
        });

      siteBId = siteB.id;
    });

    afterAll(async () => {
      if (
        createdOrganizationIds.length >
        0
      ) {
        const organizationFilter = {
          in: createdOrganizationIds,
        };

        await prisma.auditLog.deleteMany({
          where: {
            organizationId:
              organizationFilter,
          },
        });

        await prisma.authChallenge
          .deleteMany({
            where: {
              organizationId:
                organizationFilter,
            },
          });

        await prisma.userSession
          .deleteMany({
            where: {
              organizationId:
                organizationFilter,
            },
          });

        await prisma.user.deleteMany({
          where: {
            organizationId:
              organizationFilter,
          },
        });

        await prisma.site.deleteMany({
          where: {
            organizationId:
              organizationFilter,
          },
        });

        await prisma.organization
          .deleteMany({
            where: {
              id:
                organizationFilter,
            },
          });
      }

      await prisma.$disconnect();
      await app.close();
    });

    async function login(
      email: string,
      password: string,
    ): Promise<Response> {
      return request(
        app.getHttpServer(),
      )
        .post(`${API}/auth/login`)
        .send({
          email,
          password,
        });
    }

    it(
      'starts the real application and exposes health',
      async () => {
        const response = await request(
          app.getHttpServer(),
        )
          .get(`${API}/health`)
          .expect(200);

        expect(
          response.body.status,
        ).toBe('ok');
      },
    );

    it(
      'enforces mandatory first-login password replacement',
      async () => {
        const firstLogin =
          await login(
            temporaryUserA.email,
            TEMPORARY_PASSWORD,
          )
            .then((response) => {
              expect(
                response.status,
              ).toBe(200);

              return response;
            });

        const challenge =
          firstLogin.body as
            ChallengeBody;

        expect(challenge.stage).toBe(
          'PASSWORD_CHANGE_REQUIRED',
        );

        expect(
          hasRefreshCookie(
            firstLogin,
          ),
        ).toBe(false);

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/auth/password/change`,
          )
          .send({
            challengeToken:
              challenge.challengeToken,
            newPassword:
              TEMPORARY_PASSWORD,
          })
          .expect(400);

        const changed =
          await request(
            app.getHttpServer(),
          )
            .post(
              `${API}/auth/password/change`,
            )
            .send({
              challengeToken:
                challenge.challengeToken,
              newPassword:
                PERMANENT_PASSWORD,
            })
            .expect(200);

        const authenticated =
          changed.body as
            AuthenticatedBody;

        expect(
          authenticated.stage,
        ).toBe('AUTHENTICATED');

        expect(
          hasRefreshCookie(changed),
        ).toBe(true);

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/auth/password/change`,
          )
          .send({
            challengeToken:
              challenge.challengeToken,
            newPassword:
              'AnotherPassword789!',
          })
          .expect(401);

        await request(
          app.getHttpServer(),
        )
          .get(`${API}/auth/me`)
          .set(
            bearer(
              authenticated.accessToken,
            ),
          )
          .expect(200)
          .expect(
            (response: Response) => {
              expect(
                response.body.id,
              ).toBe(
                temporaryUserA.id,
              );
            },
          );
      },
    );

    it(
      'rotates refresh tokens and revokes the session after replay',
      async () => {
        const initial =
          await login(
            adminA.email,
            ADMIN_PASSWORD,
          );

        expect(initial.status).toBe(200);

        const firstCookie =
          getRefreshCookie(initial);

        const refreshed =
          await request(
            app.getHttpServer(),
          )
            .post(
              `${API}/auth/refresh`,
            )
            .set(
              'Cookie',
              firstCookie,
            )
            .expect(200);

        const secondCookie =
          getRefreshCookie(refreshed);

        expect(secondCookie).not.toBe(
          firstCookie,
        );

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/auth/refresh`,
          )
          .set(
            'Cookie',
            firstCookie,
          )
          .expect(401);

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/auth/refresh`,
          )
          .set(
            'Cookie',
            secondCookie,
          )
          .expect(401);
      },
    );

    it(
      'enforces role permissions',
      async () => {
        const viewerLogin =
          await login(
            viewerA.email,
            VIEWER_PASSWORD,
          );

        const viewerBody =
          viewerLogin.body as
            AuthenticatedBody;

        expect(viewerLogin.status).toBe(
          200,
        );

        await request(
          app.getHttpServer(),
        )
          .post(`${API}/sites`)
          .set(
            bearer(
              viewerBody.accessToken,
            ),
          )
          .send({
            name:
              'Viewer Forbidden Site',
            code:
              `VIEWER-${runId}`,
          })
          .expect(403);
      },
    );

    it(
      'isolates users, sites and sessions by organization',
      async () => {
        const [
          adminALogin,
          adminBLogin,
        ] = await Promise.all([
          login(
            adminA.email,
            ADMIN_PASSWORD,
          ),
          login(
            adminB.email,
            ADMIN_PASSWORD,
          ),
        ]);

        const adminABody =
          adminALogin.body as
            AuthenticatedBody;

        const adminBBody =
          adminBLogin.body as
            AuthenticatedBody;

        await request(
          app.getHttpServer(),
        )
          .get(
            `${API}/users/${adminB.id}`,
          )
          .set(
            bearer(
              adminABody.accessToken,
            ),
          )
          .expect(404);

        await request(
          app.getHttpServer(),
        )
          .get(
            `${API}/sites/${siteBId}`,
          )
          .set(
            bearer(
              adminABody.accessToken,
            ),
          )
          .expect(404);

        const sessionsA =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/auth/sessions`,
            )
            .set(
              bearer(
                adminABody.accessToken,
              ),
            )
            .expect(200);

        expect(
          sessionsA.body.some(
            (session: {
              userId: string;
            }) =>
              session.userId ===
              adminB.id,
          ),
        ).toBe(false);

        const sessionsB =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/auth/sessions`,
            )
            .set(
              bearer(
                adminBBody.accessToken,
              ),
            )
            .expect(200);

        const currentB =
          sessionsB.body.find(
            (session: {
              current: boolean;
              id: string;
            }) =>
              session.current,
          ) as
            | {
                id: string;
              }
            | undefined;

        expect(currentB).toBeDefined();

        await request(
          app.getHttpServer(),
        )
          .delete(
            `${API}/auth/sessions/${currentB!.id}`,
          )
          .set(
            bearer(
              adminABody.accessToken,
            ),
          )
          .expect(404);
      },
    );

    it(
      'validates the complete MFA and recovery-code flow',
      async () => {
        const initial =
          await login(
            adminA.email,
            ADMIN_PASSWORD,
          );

        const initialBody =
          initial.body as
            AuthenticatedBody;

        const setup =
          await request(
            app.getHttpServer(),
          )
            .post(
              `${API}/auth/mfa/setup`,
            )
            .set(
              bearer(
                initialBody.accessToken,
              ),
            )
            .send({})
            .expect(201);

        const secret =
          setup.body.secret as string;

        expect(secret).toMatch(
          /^[A-Z2-7]{32}$/,
        );

        const enabled =
          await request(
            app.getHttpServer(),
          )
            .post(
              `${API}/auth/mfa/enable`,
            )
            .set(
              bearer(
                initialBody.accessToken,
              ),
            )
            .send({
              code:
                currentTotp(secret),
            })
            .expect(200);

        const recoveryCodes =
          enabled.body
            .recoveryCodes as string[];

        expect(
          recoveryCodes,
        ).toHaveLength(10);

        await request(
          app.getHttpServer(),
        )
          .post(`${API}/auth/logout`)
          .set(
            bearer(
              initialBody.accessToken,
            ),
          )
          .send({})
          .expect(200);

        const protectedLogin =
          await login(
            adminA.email,
            ADMIN_PASSWORD,
          );

        const protectedBody =
          protectedLogin.body as
            ChallengeBody;

        expect(
          protectedBody.stage,
        ).toBe('MFA_REQUIRED');

        expect(
          hasRefreshCookie(
            protectedLogin,
          ),
        ).toBe(false);

        const validCode =
          currentTotp(secret);

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/auth/mfa/verify`,
          )
          .send({
            challengeToken:
              protectedBody
                .challengeToken,
            code:
              wrongTotp(validCode),
          })
          .expect(401);

        const verified =
          await request(
            app.getHttpServer(),
          )
            .post(
              `${API}/auth/mfa/verify`,
            )
            .send({
              challengeToken:
                protectedBody
                  .challengeToken,
              code:
                currentTotp(secret),
            })
            .expect(200);

        const verifiedBody =
          verified.body as
            AuthenticatedBody;

        expect(
          verifiedBody.stage,
        ).toBe('AUTHENTICATED');

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/auth/mfa/verify`,
          )
          .send({
            challengeToken:
              protectedBody
                .challengeToken,
            code:
              currentTotp(secret),
          })
          .expect(401);

        await request(
          app.getHttpServer(),
        )
          .post(`${API}/auth/logout`)
          .set(
            bearer(
              verifiedBody.accessToken,
            ),
          )
          .send({})
          .expect(200);

        const recoveryLogin =
          await login(
            adminA.email,
            ADMIN_PASSWORD,
          );

        const recoveryChallenge =
          recoveryLogin.body as
            ChallengeBody;

        const recovered =
          await request(
            app.getHttpServer(),
          )
            .post(
              `${API}/auth/mfa/verify`,
            )
            .send({
              challengeToken:
                recoveryChallenge
                  .challengeToken,
              code:
                recoveryCodes[0],
            })
            .expect(200);

        const recoveredBody =
          recovered.body as
            AuthenticatedBody;

        const statusAfterRecovery =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/auth/mfa/status`,
            )
            .set(
              bearer(
                recoveredBody.accessToken,
              ),
            )
            .expect(200);

        expect(
          statusAfterRecovery.body
            .recoveryCodeCount,
        ).toBe(9);

        await request(
          app.getHttpServer(),
        )
          .post(`${API}/auth/logout`)
          .set(
            bearer(
              recoveredBody.accessToken,
            ),
          )
          .send({})
          .expect(200);

        const reuseLogin =
          await login(
            adminA.email,
            ADMIN_PASSWORD,
          );

        const reuseChallenge =
          reuseLogin.body as
            ChallengeBody;

        await request(
          app.getHttpServer(),
        )
          .post(
            `${API}/auth/mfa/verify`,
          )
          .send({
            challengeToken:
              reuseChallenge
                .challengeToken,
            code:
              recoveryCodes[0],
          })
          .expect(401);

        const finalVerification =
          await request(
            app.getHttpServer(),
          )
            .post(
              `${API}/auth/mfa/verify`,
            )
            .send({
              challengeToken:
                reuseChallenge
                  .challengeToken,
              code:
                currentTotp(secret),
            })
            .expect(200);

        expect(
          (
            finalVerification.body as
              AuthenticatedBody
          ).stage,
        ).toBe('AUTHENTICATED');
      },
    );

    it(
      'records tenant-scoped audit evidence and redacts secrets',
      async () => {
        const adminALogin =
          await login(
            adminA.email,
            ADMIN_PASSWORD,
          );

        let adminAToken: string;

        if (
          adminALogin.body.stage ===
          'MFA_REQUIRED'
        ) {
          const user =
            await prisma.user
              .findUniqueOrThrow({
                where: {
                  id: adminA.id,
                },
              });

          expect(
            user.mfaSecretEncrypted,
          ).toBeTruthy();

          const encrypted =
            user.mfaSecretEncrypted!;

          const [
            ivHex,
            tagHex,
            encryptedHex,
          ] = encrypted.split(':');

          const {
            createDecipheriv,
          } = await import(
            'node:crypto'
          );

          const decipher =
            createDecipheriv(
              'aes-256-gcm',
              Buffer.from(
                process.env
                  .MFA_ENCRYPTION_KEY!,
                'hex',
              ),
              Buffer.from(
                ivHex,
                'hex',
              ),
            );

          decipher.setAuthTag(
            Buffer.from(
              tagHex,
              'hex',
            ),
          );

          const secret =
            Buffer.concat([
              decipher.update(
                Buffer.from(
                  encryptedHex,
                  'hex',
                ),
              ),
              decipher.final(),
            ]).toString('utf8');

          const verified =
            await request(
              app.getHttpServer(),
            )
              .post(
                `${API}/auth/mfa/verify`,
              )
              .send({
                challengeToken:
                  adminALogin.body
                    .challengeToken,
                code:
                  currentTotp(secret),
              })
              .expect(200);

          adminAToken =
            (
              verified.body as
                AuthenticatedBody
            ).accessToken;
        } else {
          adminAToken =
            (
              adminALogin.body as
                AuthenticatedBody
            ).accessToken;
        }

        const sensitivePassword =
          'SensitiveAuditPassword123!';

        const createdUser =
          await request(
            app.getHttpServer(),
          )
            .post(`${API}/users`)
            .set(
              bearer(adminAToken),
            )
            .send({
              name:
                'Audit Evidence User',
              email:
                `audit-${runId}@psop.test`,
              password:
                sensitivePassword,
              role: 'OPERATOR',
            })
            .expect(201);

        expect(
          createdUser.body
            .organizationId,
        ).toBe(organizationAId);

        await request(
          app.getHttpServer(),
        )
          .post(`${API}/sites`)
          .set(
            bearer(adminAToken),
          )
          .send({
            name:
              'Audit Evidence Site',
            code:
              `AUDIT-${runId}`,
            timezone:
              'America/New_York',
          })
          .expect(201);

        const auditA =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/audit-logs?limit=200`,
            )
            .set(
              bearer(adminAToken),
            )
            .expect(200);

        const serialized =
          JSON.stringify(
            auditA.body,
          );

        expect(serialized).not.toContain(
          sensitivePassword,
        );

        const userCreated =
          auditA.body.find(
            (entry: {
              action: string;
              entityId: string | null;
              metadata?: {
                request?: {
                  password?: string;
                };
              };
            }) =>
              entry.action ===
                'USER_CREATED' &&
              entry.entityId ===
                createdUser.body.id,
          );

        expect(userCreated).toBeDefined();

        expect(
          userCreated.metadata.request
            .password,
        ).toBe('[REDACTED]');

        expect(
          auditA.body.some(
            (entry: {
              action: string;
            }) =>
              entry.action ===
              'SITE_CREATED',
          ),
        ).toBe(true);

        const adminBLogin =
          await login(
            adminB.email,
            ADMIN_PASSWORD,
          );

        const adminBBody =
          adminBLogin.body as
            AuthenticatedBody;

        const auditB =
          await request(
            app.getHttpServer(),
          )
            .get(
              `${API}/audit-logs?limit=200`,
            )
            .set(
              bearer(
                adminBBody.accessToken,
              ),
            )
            .expect(200);

        expect(
          auditB.body.some(
            (entry: {
              organizationId: string;
            }) =>
              entry.organizationId ===
              organizationAId,
          ),
        ).toBe(false);
      },
    );
  },
);
