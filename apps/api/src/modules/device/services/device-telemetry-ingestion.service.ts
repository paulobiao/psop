import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import type {
  IngestDeviceTelemetryDto,
} from '../dto/ingest-device-telemetry.dto.js';
import {
  DeviceRepository,
} from '../repositories/device.repository.js';
import {
  deviceIngestionKeyPrefix,
  generateDeviceIngestionKey,
  hashDeviceIngestionKey,
  verifyDeviceIngestionKey,
} from '../security/device-ingestion-key.js';
import {
  DeviceConnectivityEventsService,
} from './device-connectivity-events.service.js';
import {
  DeviceTelemetryService,
} from './device-telemetry.service.js';
import {
  LocalTelemetryService,
} from './local-telemetry.service.js';

@Injectable()
export class DeviceTelemetryIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deviceRepository: DeviceRepository,
    private readonly localTelemetry: LocalTelemetryService,
    private readonly connectivityEvents:
      DeviceConnectivityEventsService,
    private readonly telemetry: DeviceTelemetryService,
  ) {}

  async rotateKey(
    organizationId: string,
    deviceId: string,
  ) {
    this.localTelemetry.assertEnabled();

    const device =
      await this.deviceRepository.findByIdWithSite(
        deviceId,
        organizationId,
      );

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (device.deviceType !== 'CAMERA') {
      throw new BadRequestException(
        'Ingestion credentials are available only for camera devices',
      );
    }

    const deviceKey = generateDeviceIngestionKey();
    const rotatedAt = new Date();
    const keyPrefix =
      deviceIngestionKeyPrefix(deviceKey);

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
      device.deviceType !== 'CAMERA' ||
      device.status !== 'ACTIVE' ||
      !device.ingestionCredential ||
      !verifyDeviceIngestionKey(
        deviceKey,
        device.ingestionCredential.keyHash,
      )
    ) {
      throw new UnauthorizedException(
        'Invalid device credentials',
      );
    }

    await this.localTelemetry.upsertSnapshot(
      device.id,
      input,
    );

    await this.connectivityEvents.evaluateFleet(
      device.site.organizationId,
    );

    return this.telemetry.findByDeviceId(
      device.id,
      device.site.organizationId,
    );
  }
}
