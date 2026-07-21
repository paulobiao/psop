import { Injectable } from '@nestjs/common';
import type { Site } from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';

@Injectable()
export class SiteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<Site[]> {
    return this.prisma.site.findMany({
      where: {
        deletedAt: null,
      },
      orderBy: {
        name: 'asc',
      },
    });
  }
}
