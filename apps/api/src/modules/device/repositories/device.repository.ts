import { Injectable } from '@nestjs/common';
import type {
  Device,
  Prisma,
} from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';

export type DeviceWithSite = Prisma.DeviceGetPayload<{
  include: {
    site: true;
  };
}>;

/**
 * The single source of truth for "PSOP can individually observe this device":
 * a directly-monitored camera / recorder / gateway, or a recorder-observed
 * (VIA_GATEWAY) camera that has a parent assigned. Every "observable device"
 * query composes this exact predicate so the rule never drifts between callers.
 */
const OBSERVABLE_DEVICE_OR: Prisma.DeviceWhereInput[] = [
  {
    monitoringMode: 'DIRECT',
    deviceType: {
      in: [
        'CAMERA',
        'RECORDER',
        'GATEWAY',
      ],
    },
  },
  {
    monitoringMode: 'VIA_GATEWAY',
    deviceType: 'CAMERA',
    gatewayDeviceId: {
      not: null,
    },
  },
];

@Injectable()
export class DeviceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    organizationId?: string,
  ): Promise<Device[]> {
    return this.prisma.device.findMany({
      where: {
        deletedAt: null,
        ...(organizationId
          ? {
              site: {
                organizationId,
                deletedAt: null,
              },
            }
          : {}),
      },
      orderBy: [
        {
          siteId: 'asc',
        },
        {
          name: 'asc',
        },
      ],
    });
  }

  async findAllCamerasWithSite(
    organizationId?: string,
  ): Promise<DeviceWithSite[]> {
    return this.prisma.device.findMany({
      where: {
        deletedAt: null,
        deviceType: 'CAMERA',
        ...(organizationId
          ? {
              site: {
                organizationId,
                deletedAt: null,
              },
            }
          : {}),
      },
      include: {
        site: true,
      },
      orderBy: [
        {
          siteId: 'asc',
        },
        {
          name: 'asc',
        },
      ],
    });
  }

  async findAllTelemetryDevicesWithSite(
    organizationId?: string,
  ): Promise<DeviceWithSite[]> {
    return this.prisma.device.findMany({
      where: {
        deletedAt: null,
        monitoringMode: 'DIRECT',
        deviceType: {
          in: [
            'CAMERA',
            'RECORDER',
            'GATEWAY',
          ],
        },
        ...(organizationId
          ? {
              site: {
                organizationId,
                deletedAt: null,
              },
            }
          : {}),
      },
      include: {
        site: true,
      },
      orderBy: [
        {
          siteId: 'asc',
        },
        {
          name: 'asc',
        },
      ],
    });
  }

  async findAllObservableDevicesWithSite(
    organizationId?: string,
  ): Promise<DeviceWithSite[]> {
    return this.prisma.device.findMany({
      where: {
        deletedAt: null,
        OR: OBSERVABLE_DEVICE_OR,
        ...(organizationId
          ? {
              site: {
                organizationId,
                deletedAt: null,
              },
            }
          : {}),
      },
      include: {
        site: true,
      },
      orderBy: [
        {
          siteId: 'asc',
        },
        {
          name: 'asc',
        },
      ],
    });
  }

  /**
   * The Site & Fleet Reliability population: individually-observable devices
   * (identical predicate to `findAllObservableDevicesWithSite`) further
   * restricted to `status === ACTIVE`.
   *
   * Non-ACTIVE devices (INACTIVE / MAINTENANCE / DECOMMISSIONED) are
   * administratively outside the operational fleet and PSOP's ingestion paths
   * (`device-telemetry-ingestion`, `recorder-observation`) already reject their
   * telemetry, so including them in a reliability aggregate would only ever
   * decay coverage/availability with data nobody can refresh. Their individual
   * history stays fully queryable through `GET /devices/:id/availability`.
   */
  async findAllReliabilityEligibleDevicesWithSite(
    organizationId?: string,
  ): Promise<DeviceWithSite[]> {
    return this.prisma.device.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        OR: OBSERVABLE_DEVICE_OR,
        ...(organizationId
          ? {
              site: {
                organizationId,
                deletedAt: null,
              },
            }
          : {}),
      },
      include: {
        site: true,
      },
      orderBy: [
        {
          siteId: 'asc',
        },
        {
          name: 'asc',
        },
      ],
    });
  }

  async findById(
    id: string,
    organizationId?: string,
  ): Promise<Device | null> {
    return this.prisma.device.findFirst({
      where: {
        id,
        deletedAt: null,
        ...(organizationId
          ? {
              site: {
                organizationId,
                deletedAt: null,
              },
            }
          : {}),
      },
    });
  }

  async findByIdWithSite(
    id: string,
    organizationId?: string,
  ): Promise<DeviceWithSite | null> {
    return this.prisma.device.findFirst({
      where: {
        id,
        deletedAt: null,
        ...(organizationId
          ? {
              site: {
                organizationId,
                deletedAt: null,
              },
            }
          : {}),
      },
      include: {
        site: true,
      },
    });
  }

  async siteBelongsToOrganization(
    siteId: string,
    organizationId: string,
  ): Promise<boolean> {
    const site = await this.prisma.site.findFirst({
      where: {
        id: siteId,
        organizationId,
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });

    return Boolean(site);
  }

  async countManagedDevices(
    gatewayDeviceId: string,
  ): Promise<number> {
    return this.prisma.device.count({
      where: {
        gatewayDeviceId,
        deletedAt: null,
      },
    });
  }

  async create(
    data: Prisma.DeviceUncheckedCreateInput,
  ): Promise<Device> {
    return this.prisma.device.create({
      data,
    });
  }

  async update(
    id: string,
    data: Prisma.DeviceUncheckedUpdateInput,
  ): Promise<Device> {
    return this.prisma.device.update({
      where: {
        id,
      },
      data,
    });
  }

  async softDelete(id: string): Promise<Device> {
    return this.prisma.device.update({
      where: {
        id,
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }
}
