import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DeviceRepository } from '../repositories/device.repository';

type ConnectivityState = 'ONLINE' | 'OFFLINE' | 'NEVER_SEEN' | 'UNKNOWN';

@Injectable()
export class DeviceTelemetryService {
  private readonly logger = new Logger(DeviceTelemetryService.name);
  private readonly tableName: string;
  private readonly offlineMultiplier: number;
  private readonly documentClient: DynamoDBDocumentClient;

  constructor(
    configService: ConfigService,
    private readonly deviceRepository: DeviceRepository,
  ) {
    const region = configService.get<string>('AWS_REGION') ?? 'us-east-1';

    this.tableName =
      configService.get<string>('DYNAMODB_STATUS_TABLE') ??
      'camera-fleet-monitor-status';

    this.offlineMultiplier = Number(
      configService.get<string>('TELEMETRY_OFFLINE_MULTIPLIER') ?? '2',
    );

    this.documentClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region,
      }),
    );
  }

  async findByDeviceId(id: string) {
    const device = await this.deviceRepository.findByIdWithSite(id);

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (device.deviceType !== 'CAMERA') {
      throw new BadRequestException(
        'Telemetry is currently available only for camera devices',
      );
    }

    let item: Record<string, unknown> | undefined;

    try {
      const response = await this.documentClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: {
            site_id: device.site.code.toLowerCase(),
            camera_id: device.externalId,
          },
        }),
      );

      item = response.Item;
    } catch (error) {
      this.logger.error(
        'Unable to read device telemetry from DynamoDB',
        error instanceof Error ? error.stack : String(error),
      );

      throw new ServiceUnavailableException('Telemetry storage is unavailable');
    }

    const timestamp = this.toNumber(item?.timestamp);
    const now = Math.floor(Date.now() / 1000);
    const ageSeconds = timestamp === null ? null : Math.max(0, now - timestamp);

    const offlineAfterSeconds =
      device.expectedHeartbeatInterval * this.offlineMultiplier;

    let state: ConnectivityState;

    if (!item) {
      state = 'NEVER_SEEN';
    } else if (timestamp === null) {
      state = 'UNKNOWN';
    } else if (ageSeconds !== null && ageSeconds <= offlineAfterSeconds) {
      state = 'ONLINE';
    } else {
      state = 'OFFLINE';
    }

    return {
      device: {
        id: device.id,
        name: device.name,
        externalId: device.externalId,
        deviceType: device.deviceType,
        administrativeStatus: device.status,
        siteId: device.siteId,
        siteCode: device.site.code,
        siteName: device.site.name,
      },
      connectivity: {
        state,
        lastHeartbeatAt:
          timestamp === null ? null : new Date(timestamp * 1000).toISOString(),
        ageSeconds,
        expectedHeartbeatIntervalSeconds: device.expectedHeartbeatInterval,
        offlineAfterSeconds,
      },
      telemetry: item
        ? {
            reportedStatus: this.toString(item.status),
            temperatureC: this.toNumber(item.temperature_c),
            bitrateKbps: this.toNumber(item.bitrate_kbps),
            storageUsedPct: this.toNumber(item.storage_used_pct),
            uptimeSeconds: this.toNumber(item.uptime_seconds),
            model: this.toString(item.model),
            firmware: this.toString(item.firmware),
            isoTime: this.toString(item.iso_time),
          }
        : null,
    };
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private toString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }
}
