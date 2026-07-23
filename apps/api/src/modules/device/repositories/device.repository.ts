import { Injectable } from '@nestjs/common';
import type { Device, Prisma } from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';

export type DeviceWithSite = Prisma.DeviceGetPayload<{
  include: {
    site: true;
  };
}>;

@Injectable()
export class DeviceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<Device[]> {
    return this.prisma.device.findMany({
      where: {
        deletedAt: null,
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

  async findById(id: string): Promise<Device | null> {
    return this.prisma.device.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });
  }

  async findByIdWithSite(id: string): Promise<DeviceWithSite | null> {
    return this.prisma.device.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      include: {
        site: true,
      },
    });
  }

  async create(data: Prisma.DeviceUncheckedCreateInput): Promise<Device> {
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
