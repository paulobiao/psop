import {
  Injectable,
  Logger,
} from '@nestjs/common';
import type {
  Prisma,
} from '../../../../generated/prisma/client.js';
import { AuditRepository } from '../repositories/audit.repository.js';

export interface AuditRecordInput {
  organizationId: string;
  actorUserId: string;
  actorName: string;
  actorEmail: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId?: string;
  method: string;
  path: string;
  statusCode: number;
  ipAddress?: string;
  userAgent?: string;
  metadata: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger =
    new Logger(AuditService.name);

  constructor(
    private readonly auditRepository: AuditRepository,
  ) {}

  async record(
    input: AuditRecordInput,
  ): Promise<void> {
    try {
      await this.auditRepository.create({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        actorName: input.actorName,
        actorEmail: input.actorEmail,
        actorRole: input.actorRole,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        method: input.method,
        path: input.path,
        statusCode: input.statusCode,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        metadata: this.toJson(input.metadata),
      });
    } catch (error) {
      this.logger.error(
        'Unable to persist audit log',
        error instanceof Error
          ? error.stack
          : String(error),
      );
    }
  }

  findAll(
    organizationId: string,
    limit = 100,
  ) {
    const safeLimit = Math.min(
      Math.max(limit, 1),
      500,
    );

    return this.auditRepository.findAll(
      organizationId,
      safeLimit,
    );
  }

  private toJson(
    value: unknown,
  ): Prisma.InputJsonValue {
    return JSON.parse(
      JSON.stringify(value),
    ) as Prisma.InputJsonValue;
  }
}
