import { Injectable } from '@nestjs/common';
import type {
  AlertSeverity,
  AlertStatus,
  Prisma,
} from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';

export type AlertWithDevice = Prisma.AlertGetPayload<{
  include: {
    device: {
      include: {
        site: true;
      };
    };
  };
}>;

interface AlertFilters {
  status?: AlertStatus;
  deviceId?: string;
  organizationId?: string;
}

interface OpenConnectivityAlertInput {
  deviceId: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  connectivityState: string;
}

@Injectable()
export class AlertRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    filters: AlertFilters = {},
  ): Promise<AlertWithDevice[]> {
    return this.prisma.alert.findMany({
      where: {
        status: filters.status,
        deviceId: filters.deviceId,
        ...(filters.organizationId
          ? {
              device: {
                deletedAt: null,
                site: {
                  organizationId: filters.organizationId,
                  deletedAt: null,
                },
              },
            }
          : {}),
      },
      include: {
        device: {
          include: {
            site: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findById(
    id: string,
    organizationId?: string,
  ): Promise<AlertWithDevice | null> {
    return this.prisma.alert.findFirst({
      where: {
        id,
        ...(organizationId
          ? {
              device: {
                deletedAt: null,
                site: {
                  organizationId,
                  deletedAt: null,
                },
              },
            }
          : {}),
      },
      include: {
        device: {
          include: {
            site: true,
          },
        },
      },
    });
  }

  async findRecentConnectivityIncidents(input: {
    organizationId: string;
    limit?: number;
    deviceId?: string;
  }): Promise<AlertWithDevice[]> {
    const limit = Math.min(
      Math.max(input.limit ?? 50, 1),
      100,
    );

    return this.prisma.alert.findMany({
      where: {
        type: 'DEVICE_CONNECTIVITY',
        deviceId: input.deviceId,
        device: {
          deletedAt: null,
          site: {
            organizationId: input.organizationId,
            deletedAt: null,
          },
        },
      },
      include: {
        device: {
          include: {
            site: true,
          },
        },
      },
      orderBy: {
        openedAt: 'desc',
      },
      take: limit,
    });
  }

  async getConnectivityIncidentAnalytics(
    organizationId: string,
    now = new Date(),
  ) {
    const dayAgo = new Date(
      now.getTime() - 24 * 60 * 60 * 1000,
    );

    const recentWindowDays = 30;
    const recentSince = new Date(
      now.getTime() -
        recentWindowDays * 24 * 60 * 60 * 1000,
    );

    const tenantWhere = {
      type: 'DEVICE_CONNECTIVITY' as const,
      device: {
        deletedAt: null,
        site: {
          organizationId,
          deletedAt: null,
        },
      },
    };

    const [
      activeCount,
      recoveredCount,
      recoveredLast24h,
      recentResolved,
    ] = await Promise.all([
      this.prisma.alert.count({
        where: {
          ...tenantWhere,
          status: 'OPEN',
        },
      }),
      this.prisma.alert.count({
        where: {
          ...tenantWhere,
          status: 'RESOLVED',
        },
      }),
      this.prisma.alert.count({
        where: {
          ...tenantWhere,
          status: 'RESOLVED',
          resolvedAt: {
            gte: dayAgo,
          },
        },
      }),
      this.prisma.alert.findMany({
        where: {
          ...tenantWhere,
          status: 'RESOLVED',
          resolvedAt: {
            gte: recentSince,
          },
        },
        select: {
          id: true,
          openedAt: true,
          resolvedAt: true,
        },
      }),
    ]);

    const durations = recentResolved.flatMap(
      (incident) => {
        if (!incident.resolvedAt) {
          return [];
        }

        return [
          {
            id: incident.id,
            seconds: Math.max(
              0,
              Math.floor(
                (
                  incident.resolvedAt.getTime() -
                  incident.openedAt.getTime()
                ) / 1000,
              ),
            ),
          },
        ];
      },
    );

    const totalSeconds = durations.reduce(
      (sum, incident) =>
        sum + incident.seconds,
      0,
    );

    const longest = durations.reduce<
      { id: string; seconds: number } | null
    >(
      (current, incident) =>
        !current ||
        incident.seconds > current.seconds
          ? incident
          : current,
      null,
    );

    return {
      activeCount,
      recoveredCount,
      recoveredLast24h,
      meanRecoverySeconds:
        durations.length > 0
          ? Math.round(
              totalSeconds / durations.length,
            )
          : null,
      longestRecentIncidentSeconds:
        longest?.seconds ?? null,
      longestRecentIncidentId:
        longest?.id ?? null,
      recoverySampleCount:
        durations.length,
      recoveryWindowDays:
        recentWindowDays,
    };
  }

  async openConnectivityAlert(
    input: OpenConnectivityAlertInput,
  ): Promise<AlertWithDevice> {
    const now = new Date();
    const dedupKey =
      `${input.deviceId}:DEVICE_CONNECTIVITY`;

    const existing =
      await this.prisma.alert.findUnique({
        where: {
          dedupKey,
        },
        select: {
          severity: true,
        },
      });

    const peakSeverity: AlertSeverity =
      existing?.severity === 'CRITICAL'
        ? 'CRITICAL'
        : input.severity;

    return this.prisma.alert.upsert({
      where: {
        dedupKey,
      },
      update: {
        status: 'OPEN',
        severity: peakSeverity,
        title: input.title,
        message: input.message,
        connectivityState: input.connectivityState,
        lastDetectedAt: now,
        resolvedAt: null,
      },
      create: {
        deviceId: input.deviceId,
        type: 'DEVICE_CONNECTIVITY',
        status: 'OPEN',
        severity: input.severity,
        title: input.title,
        message: input.message,
        connectivityState: input.connectivityState,
        dedupKey,
        openedAt: now,
        lastDetectedAt: now,
      },
      include: {
        device: {
          include: {
            site: true,
          },
        },
      },
    });
  }

  async resolveConnectivityAlert(
    deviceId: string,
    connectivityState = 'ONLINE',
  ): Promise<AlertWithDevice | null> {
    const alert = await this.prisma.alert.findFirst({
      where: {
        deviceId,
        type: 'DEVICE_CONNECTIVITY',
        status: 'OPEN',
      },
    });

    if (!alert) {
      return null;
    }

    return this.prisma.alert.update({
      where: {
        id: alert.id,
      },
      data: {
        status: 'RESOLVED',
        connectivityState,
        dedupKey: null,
        resolvedAt: new Date(),
        lastDetectedAt: new Date(),
      },
      include: {
        device: {
          include: {
            site: true,
          },
        },
      },
    });
  }

  async resolveById(
    id: string,
  ): Promise<AlertWithDevice> {
    return this.prisma.alert.update({
      where: {
        id,
      },
      data: {
        status: 'RESOLVED',
        dedupKey: null,
        resolvedAt: new Date(),
        lastDetectedAt: new Date(),
      },
      include: {
        device: {
          include: {
            site: true,
          },
        },
      },
    });
  }
}
