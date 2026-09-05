import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { IngestDeviceTelemetryDto } from '../dto/ingest-device-telemetry.dto.js';
import type { RecorderObservedDeviceDto } from '../dto/ingest-recorder-observations.dto.js';
import { DeviceRepository } from '../repositories/device.repository.js';

@Injectable()
export class DeviceEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DeviceRepository,
  ) {}

  recordDirectTelemetry(
    device: { id: string; deviceType: string },
    input: IngestDeviceTelemetryDto,
  ) {
    const observedAt = new Date(input.timestamp * 1000);
    const expiresAt = new Date(
      observedAt.getTime() + 2 * 60 * 1000,
    );

    return this.prisma.evidenceRecord.createMany({
      data: [{
        deviceId: device.id,
        kind: 'OBSERVATION',
        source: this.directSource(device.deviceType),
        confidence: 'OBSERVED',
        level: 'E1_ENDPOINT_REACHABLE',
        subject: 'device.telemetry',
        observedAt,
        expiresAt,
        sourceEventKey: `device:${device.id}:telemetry:${input.timestamp}`,
        payload: this.json({
          status: input.status ?? null,
          temperatureC: input.temperatureC ?? null,
          bitrateKbps: input.bitrateKbps ?? null,
          storageUsedPct: input.storageUsedPct ?? null,
          uptimeSeconds: input.uptimeSeconds ?? null,
          model: input.model ?? null,
          firmware: input.firmware ?? null,
          collectionState: input.collectionState ?? null,
          collectionIssues: input.collectionIssues ?? null,
          capabilities: input.capabilities ?? null,
          details: input.details ?? null,
        }),
      }],
      skipDuplicates: true,
    });
  }

  private directSource(deviceType: string): 'DEVICE' | 'ADAPTER' | 'GATEWAY' {
    if (deviceType === 'RECORDER') {
      return 'ADAPTER';
    }
    if (deviceType === 'GATEWAY') {
      return 'GATEWAY';
    }
    return 'DEVICE';
  }

  recordRecorderObservations(
    recorderDeviceId: string,
    timestamp: number,
    observations: RecorderObservedDeviceDto[],
  ) {
    const observedAt = new Date(timestamp * 1000);
    const expiresAt = new Date(observedAt.getTime() + 2 * 60 * 1000);

    return this.prisma.evidenceRecord.createMany({
      data: observations.map((observation) => ({
        deviceId: observation.deviceId,
        observerDeviceId: recorderDeviceId,
        kind: 'OBSERVATION' as const,
        source: 'RECORDER' as const,
        confidence: 'VERIFIED' as const,
        level: 'E3_PROFILE_DISCOVERED' as const,
        subject: 'recorder.channel',
        observedAt,
        expiresAt,
        sourceEventKey: `recorder:${recorderDeviceId}:${observation.deviceId}:${timestamp}`,
        payload: this.json(observation),
      })),
      skipDuplicates: true,
    });
  }

  async findByDeviceId(
    deviceId: string,
    organizationId: string,
    limit: number,
  ) {
    const device = await this.devices.findByIdWithSite(
      deviceId,
      organizationId,
    );

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    const records = await this.prisma.evidenceRecord.findMany({
      where: { deviceId },
      orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });

    const now = Date.now();
    return {
      deviceId,
      generatedAt: new Date(now).toISOString(),
      count: records.length,
      evidence: records.map((record) => ({
        ...record,
        freshness:
          record.expiresAt === null
            ? 'UNKNOWN'
            : record.expiresAt.getTime() >= now
              ? 'FRESH'
              : 'STALE',
      })),
    };
  }

  private json(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
