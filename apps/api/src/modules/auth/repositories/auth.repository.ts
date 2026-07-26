import { Injectable } from '@nestjs/common';
import type {
  AuthChallenge,
  Prisma,
  User,
  UserSession,
} from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';

@Injectable()
export class AuthRepository {
  constructor(
    private readonly prisma:
      PrismaService,
  ) {}

  findActiveByEmail(
    email: string,
  ): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: {
        email,
        status: 'ACTIVE',
        deletedAt: null,
        organization: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      },
    });
  }

  findActiveById(
    id: string,
  ): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: {
        id,
        status: 'ACTIVE',
        deletedAt: null,
        organization: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      },
    });
  }

  findUserInOrganization(
    id: string,
    organizationId: string,
  ): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: {
        id,
        organizationId,
        deletedAt: null,
      },
    });
  }

  markLogin(
    id: string,
  ): Promise<User> {
    return this.prisma.user.update({
      where: {
        id,
      },
      data: {
        lastLoginAt: new Date(),
      },
    });
  }

  createSession(
    data:
      Prisma.UserSessionUncheckedCreateInput,
  ): Promise<UserSession> {
    return this.prisma.userSession
      .create({
        data,
      });
  }

  findActiveSession(
    id: string,
    userId: string,
  ): Promise<UserSession | null> {
    return this.prisma.userSession
      .findFirst({
        where: {
          id,
          userId,
          revokedAt: null,
          expiresAt: {
            gt: new Date(),
          },
        },
      });
  }

  rotateSession(
    id: string,
    userId: string,
    currentHash: string,
    nextHash: string,
    expiresAt: Date,
    context: {
      ipAddress?: string;
      userAgent?: string;
    },
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.userSession
      .updateMany({
        where: {
          id,
          userId,
          refreshTokenHash:
            currentHash,
          revokedAt: null,
          expiresAt: {
            gt: new Date(),
          },
        },
        data: {
          refreshTokenHash:
            nextHash,
          expiresAt,
          lastUsedAt: new Date(),
          ...(context.ipAddress
            ? {
                ipAddress:
                  context.ipAddress,
              }
            : {}),
          ...(context.userAgent
            ? {
                userAgent:
                  context.userAgent,
              }
            : {}),
        },
      });
  }

  revokeSessionForUser(
    id: string,
    userId: string,
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.userSession
      .updateMany({
        where: {
          id,
          userId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
  }

  revokeSessionForOrganization(
    id: string,
    organizationId: string,
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.userSession
      .updateMany({
        where: {
          id,
          organizationId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
  }

  revokeAllSessionsForUser(
    userId: string,
    organizationId: string,
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.userSession
      .updateMany({
        where: {
          userId,
          organizationId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
  }

  revokeAllSessionsExcept(
    userId: string,
    organizationId: string,
    sessionId: string,
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.userSession
      .updateMany({
        where: {
          userId,
          organizationId,
          id: {
            not: sessionId,
          },
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
  }

  listSessions(
    organizationId: string,
  ) {
    return this.prisma.userSession
      .findMany({
        where: {
          organizationId,
        },
        include: {
          user: {
            select: {
              name: true,
              email: true,
              role: true,
              status: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 200,
      });
  }

  updatePasswordRequirement(
    userId: string,
    passwordHash: string,
    mustChangePassword: boolean,
  ): Promise<User> {
    return this.prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        passwordHash,
        mustChangePassword,
      },
    });
  }

  saveMfaSecret(
    userId: string,
    encryptedSecret: string,
  ): Promise<User> {
    return this.prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        mfaSecretEncrypted:
          encryptedSecret,
        mfaEnabled: false,
        mfaRecoveryCodeHashes: [],
        mfaEnabledAt: null,
      },
    });
  }

  enableMfa(
    userId: string,
    recoveryCodeHashes: string[],
  ): Promise<User> {
    return this.prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        mfaEnabled: true,
        mfaEnabledAt: new Date(),
        mfaRecoveryCodeHashes:
          recoveryCodeHashes,
      },
    });
  }

  disableMfa(
    userId: string,
  ): Promise<User> {
    return this.prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        mfaEnabled: false,
        mfaSecretEncrypted: null,
        mfaRecoveryCodeHashes: [],
        mfaEnabledAt: null,
      },
    });
  }

  replaceRecoveryCodes(
    userId: string,
    hashes: string[],
  ): Promise<User> {
    return this.prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        mfaRecoveryCodeHashes:
          hashes,
      },
    });
  }

  createChallenge(
    data:
      Prisma.AuthChallengeUncheckedCreateInput,
  ): Promise<AuthChallenge> {
    return this.prisma.authChallenge
      .create({
        data,
      });
  }

  findActiveChallenge(
    id: string,
    userId: string,
    type: string,
  ): Promise<AuthChallenge | null> {
    return this.prisma.authChallenge
      .findFirst({
        where: {
          id,
          userId,
          type,
          usedAt: null,
          expiresAt: {
            gt: new Date(),
          },
        },
      });
  }

  consumeChallenge(
    id: string,
    userId: string,
    type: string,
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.authChallenge
      .updateMany({
        where: {
          id,
          userId,
          type,
          usedAt: null,
          expiresAt: {
            gt: new Date(),
          },
        },
        data: {
          usedAt: new Date(),
        },
      });
  }
}
