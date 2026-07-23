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

  async findAll(filters: AlertFilters = {}): Promise<AlertWithDevice[]> {
    return this.prisma.alert.findMany({
      where: {
        status: filters.status,
        deviceId: filters.deviceId,
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

  async findById(id: string): Promise<AlertWithDevice | null> {
    return this.prisma.alert.findUnique({
      where: {
        id,
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

  async openConnectivityAlert(
    input: OpenConnectivityAlertInput,
  ): Promise<AlertWithDevice> {
    const now = new Date();
    const dedupKey = `${input.deviceId}:DEVICE_CONNECTIVITY`;

    return this.prisma.alert.upsert({
      where: {
        dedupKey,
      },
      update: {
        severity: input.severity,
        title: input.title,
        message: input.message,
        connectivityState: input.connectivityState,
        lastDetectedAt: now,
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
        connectivityState: 'ONLINE',
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

  async resolveById(id: string): Promise<AlertWithDevice> {
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
