import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  Site,
} from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';

@Injectable()
export class SiteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(organizationId: string): Promise<Site[]> {
    return this.prisma.site.findMany({
      where: {
        organizationId,
        deletedAt: null,
      },
      orderBy: { name: 'asc' },
    });
  }

  async findById(
    id: string,
    organizationId: string,
  ): Promise<Site | null> {
    return this.prisma.site.findFirst({
      where: {
        id,
        organizationId,
        deletedAt: null,
      },
    });
  }

  async create(
    data: Prisma.SiteUncheckedCreateInput,
  ): Promise<Site> {
    return this.prisma.site.create({ data });
  }

  async update(
    id: string,
    data: Prisma.SiteUncheckedUpdateInput,
  ): Promise<Site> {
    return this.prisma.site.update({
      where: { id },
      data,
    });
  }

  async softDelete(id: string): Promise<Site> {
    return this.prisma.site.update({
      where: { id },
      data: {
        deletedAt: new Date(),
      },
    });
  }
}
