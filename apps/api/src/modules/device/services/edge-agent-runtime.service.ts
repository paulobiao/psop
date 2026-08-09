import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import type {
  EdgeAgentDeliveryState,
} from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type {
  IngestDeviceTelemetryDto,
} from '../dto/ingest-device-telemetry.dto.js';

@Injectable()
export class EdgeAgentRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  validateInput(
    input: IngestDeviceTelemetryDto,
  ): void {
    const hasAny = [
      input.agentVersion,
      input.runtimeStartedAt,
      input.runtimeUptimeSeconds,
      input.previousDeliveryState,
      input.pendingBufferCount,
      input.lastSuccessfulDeliveryAt,
      input.lastDeliveryError,
      input.lastDeliveryErrorAt,
    ].some((value) => value !== undefined);

    if (!hasAny) {
      return;
    }

    if (
      input.agentVersion === undefined ||
      input.runtimeStartedAt === undefined ||
      input.runtimeUptimeSeconds === undefined ||
      input.pendingBufferCount === undefined
    ) {
      throw new BadRequestException(
        'Complete edge agent runtime metadata is required',
      );
    }

    if (
      input.lastDeliveryError &&
      !input.lastDeliveryErrorAt
    ) {
      throw new BadRequestException(
        'lastDeliveryErrorAt is required when lastDeliveryError is present',
      );
    }
  }

  async recordSuccessfulDelivery(
    deviceId: string,
    input: IngestDeviceTelemetryDto,
  ) {
    if (
      input.agentVersion === undefined ||
      input.runtimeStartedAt === undefined ||
      input.runtimeUptimeSeconds === undefined ||
      input.pendingBufferCount === undefined
    ) {
      return null;
    }

    const reportedAt = new Date();

    const optionalUpdate = {
      ...(input.previousDeliveryState !== undefined
        ? {
            previousDeliveryState:
              this.deliveryState(
                input.previousDeliveryState,
              ),
          }
        : {}),
      ...(input.lastDeliveryError !== undefined
        ? {
            lastDeliveryError:
              input.lastDeliveryError,
            lastDeliveryErrorAt:
              input.lastDeliveryErrorAt
                ? new Date(
                    input.lastDeliveryErrorAt,
                  )
                : null,
          }
        : {}),
    };

    return this.prisma.edgeAgentRuntimeSnapshot.upsert({
      where: {
        deviceId,
      },
      update: {
        agentVersion: input.agentVersion,
        runtimeStartedAt:
          new Date(input.runtimeStartedAt),
        uptimeSeconds:
          input.runtimeUptimeSeconds,
        deliveryState: 'DELIVERED',
        pendingBufferCount:
          input.pendingBufferCount,
        lastSuccessfulDeliveryAt:
          reportedAt,
        reportedAt,
        ...optionalUpdate,
      },
      create: {
        deviceId,
        agentVersion: input.agentVersion,
        runtimeStartedAt:
          new Date(input.runtimeStartedAt),
        uptimeSeconds:
          input.runtimeUptimeSeconds,
        deliveryState: 'DELIVERED',
        previousDeliveryState:
          this.deliveryState(
            input.previousDeliveryState,
          ),
        pendingBufferCount:
          input.pendingBufferCount,
        lastSuccessfulDeliveryAt:
          reportedAt,
        lastDeliveryError:
          input.lastDeliveryError ?? null,
        lastDeliveryErrorAt:
          input.lastDeliveryErrorAt
            ? new Date(
                input.lastDeliveryErrorAt,
              )
            : null,
        reportedAt,
      },
    });
  }

  findByOrganization(
    organizationId: string,
  ) {
    return this.prisma.edgeAgentRuntimeSnapshot.findMany({
      where: {
        device: {
          deletedAt: null,
          site: {
            organizationId,
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
        reportedAt: 'desc',
      },
    });
  }

  private deliveryState(
    value:
      | 'DELIVERED'
      | 'BUFFERED'
      | 'ERROR'
      | undefined,
  ): EdgeAgentDeliveryState | null {
    return value ?? null;
  }
}
