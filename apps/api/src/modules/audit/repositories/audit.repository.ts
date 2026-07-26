import { Injectable } from '@nestjs/common';
import type {
  AuditLog,
  Prisma,
} from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';

@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    data: Prisma.AuditLogUncheckedCreateInput,
  ): Promise<AuditLog> {
    return this.prisma.auditLog.create({
      data,
    });
  }

  findAll(
    organizationId: string,
    limit: number,
  ): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: {
        organizationId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: limit,
    });
  }
}
