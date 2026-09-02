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
        OR: [
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
        ],
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
