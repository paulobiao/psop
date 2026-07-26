import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  User,
  UserSession,
} from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActiveByEmail(email: string): Promise<User | null> {
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

  findActiveById(id: string): Promise<User | null> {
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

  markLogin(id: string): Promise<User> {
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
    data: Prisma.UserSessionUncheckedCreateInput,
  ): Promise<UserSession> {
    return this.prisma.userSession.create({
      data,
    });
  }

  findActiveSession(
    id: string,
    userId: string,
  ): Promise<UserSession | null> {
    return this.prisma.userSession.findFirst({
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
    currentRefreshTokenHash: string,
    nextRefreshTokenHash: string,
    expiresAt: Date,
    context: {
      ipAddress?: string;
      userAgent?: string;
    },
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.userSession.updateMany({
      where: {
        id,
        userId,
        refreshTokenHash:
          currentRefreshTokenHash,
        revokedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      data: {
        refreshTokenHash:
          nextRefreshTokenHash,
        expiresAt,
        lastUsedAt: new Date(),
        ...(context.ipAddress
          ? { ipAddress: context.ipAddress }
          : {}),
        ...(context.userAgent
          ? { userAgent: context.userAgent }
          : {}),
      },
    });
  }

  revokeSessionForUser(
    id: string,
    userId: string,
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.userSession.updateMany({
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
    return this.prisma.userSession.updateMany({
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
    return this.prisma.userSession.updateMany({
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

  listSessions(organizationId: string) {
    return this.prisma.userSession.findMany({
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
}
