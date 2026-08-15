import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import type { IngestDeviceTelemetryDto } from '../dto/ingest-device-telemetry.dto.js';
import type { IngestRecorderObservationsDto } from '../dto/ingest-recorder-observations.dto.js';
import { DeviceRepository } from '../repositories/device.repository.js';
import {
  deviceIngestionKeyPrefix,
  generateDeviceIngestionKey,
  hashDeviceIngestionKey,
  verifyDeviceIngestionKey,
} from '../security/device-ingestion-key.js';
import { DeviceConnectivityEventsService } from './device-connectivity-events.service.js';
import { EdgeAgentRuntimeService } from './edge-agent-runtime.service.js';
import { DeviceTelemetryService } from './device-telemetry.service.js';
import { LocalTelemetryService } from './local-telemetry.service.js';
import { RecorderObservationService } from './recorder-observation.service.js';

@Injectable()
export class DeviceTelemetryIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deviceRepository: DeviceRepository,
    private readonly localTelemetry: LocalTelemetryService,
    private readonly connectivityEvents: DeviceConnectivityEventsService,
    private readonly edgeAgentRuntime: EdgeAgentRuntimeService,
    private readonly telemetry: DeviceTelemetryService,
    private readonly recorderObservations: RecorderObservationService,
  ) {}

  async getKeyStatus(organizationId: string, deviceId: string) {
    const device = await this.deviceRepository.findByIdWithSite(
      deviceId,
      organizationId,
    );

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (
      !['CAMERA', 'RECORDER', 'GATEWAY'].includes(
        device.deviceType,
      ) ||
      device.monitoringMode !== 'DIRECT'
    ) {
      throw new BadRequestException(
        'Ingestion credentials are available only for directly monitored cameras, recorders and gateways',
      );
    }

    const credential = await this.prisma.deviceIngestionCredential.findUnique({
      where: {
        deviceId,
      },
      select: {
        keyPrefix: true,
        rotatedAt: true,
      },
    });

    return {
      enabled: this.localTelemetry.isEnabled(),
      configured: Boolean(credential),
      keyPrefix: credential?.keyPrefix ?? null,
      rotatedAt: credential?.rotatedAt.toISOString() ?? null,
    };
  }

  async rotateKey(organizationId: string, deviceId: string) {
    this.localTelemetry.assertEnabled();

    const device = await this.deviceRepository.findByIdWithSite(
      deviceId,
      organizationId,
    );

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (
      !['CAMERA', 'RECORDER', 'GATEWAY'].includes(
        device.deviceType,
      ) ||
      device.monitoringMode !== 'DIRECT'
    ) {
      throw new BadRequestException(
        'Ingestion credentials are available only for directly monitored cameras, recorders and gateways',
      );
    }

    const deviceKey = generateDeviceIngestionKey();
    const rotatedAt = new Date();
    const keyPrefix = deviceIngestionKeyPrefix(deviceKey);

    await this.prisma.deviceIngestionCredential.upsert({
      where: { deviceId },
      update: {
        keyHash: hashDeviceIngestionKey(deviceKey),
        keyPrefix,
        rotatedAt,
      },
      create: {
        deviceId,
        keyHash: hashDeviceIngestionKey(deviceKey),
        keyPrefix,
        rotatedAt,
      },
    });

    return {
      enabled: this.localTelemetry.isEnabled(),
      configured: true,
      deviceId,
      externalId: device.externalId,
      deviceKey,
      keyPrefix,
      rotatedAt: rotatedAt.toISOString(),
    };
  }

  async ingest(
    deviceId: string,
    deviceKey: string,
    input: IngestDeviceTelemetryDto,
  ) {
    this.localTelemetry.assertEnabled();

    const nowSeconds = Math.floor(Date.now() / 1000);

    this.edgeAgentRuntime.validateInput(input);

    if (input.timestamp > nowSeconds + 300) {
      throw new BadRequestException(
        'Telemetry timestamp is too far in the future',
      );
    }

    const device = await this.prisma.device.findFirst({
      where: {
        id: deviceId,
        deletedAt: null,
        site: { deletedAt: null },
      },
      include: {
        site: true,
        ingestionCredential: true,
      },
    });

    if (
      !device ||
      !['CAMERA', 'RECORDER', 'GATEWAY'].includes(
        device.deviceType,
      ) ||
      device.monitoringMode !== 'DIRECT' ||
      device.status !== 'ACTIVE' ||
      !device.ingestionCredential ||
      !verifyDeviceIngestionKey(deviceKey, device.ingestionCredential.keyHash)
    ) {
      throw new UnauthorizedException('Invalid device credentials');
    }

    await this.localTelemetry.upsertSnapshot(device.id, input);

    await this.edgeAgentRuntime.recordSuccessfulDelivery(
      device.id,
      input,
    );

    await this.connectivityEvents.evaluateFleet(device.site.organizationId);

    return this.telemetry.findByDeviceId(device.id, device.site.organizationId);
  }

  async ingestRecorderObservations(
    recorderDeviceId: string,
    deviceKey: string,
    input: IngestRecorderObservationsDto,
  ) {
    this.localTelemetry.assertEnabled();

    const nowSeconds = Math.floor(Date.now() / 1000);

    if (input.timestamp > nowSeconds + 300) {
      throw new BadRequestException(
        'Telemetry timestamp is too far in the future',
      );
    }

    const recorder =
      await this.prisma.device.findFirst({
        where: {
          id: recorderDeviceId,
          deletedAt: null,
          site: {
            deletedAt: null,
          },
        },
        include: {
          site: true,
          ingestionCredential: true,
        },
      });

    if (
      !recorder ||
      recorder.deviceType !== 'RECORDER' ||
      recorder.monitoringMode !== 'DIRECT' ||
      recorder.status !== 'ACTIVE' ||
      !recorder.ingestionCredential ||
      !verifyDeviceIngestionKey(
        deviceKey,
        recorder.ingestionCredential.keyHash,
      )
    ) {
      throw new UnauthorizedException(
        'Invalid recorder credentials',
      );
    }

    const stored =
      await this.recorderObservations.upsertBatch(
        recorder,
        input.timestamp,
        input.observations,
      );

    await this.connectivityEvents.evaluateFleet(
      recorder.site.organizationId,
    );

    const observations =
      await Promise.all(
        input.observations.map(
          (observation) =>
            this.telemetry.findByDeviceId(
              observation.deviceId,
              recorder.site.organizationId,
            ),
        ),
      );

    return {
      recorderDeviceId: recorder.id,
      ...stored,
      observations,
    };
  }

}
