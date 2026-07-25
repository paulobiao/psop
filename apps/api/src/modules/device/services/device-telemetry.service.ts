import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DeviceRepository,
  DeviceWithSite,
} from '../repositories/device.repository';

type ConnectivityState = 'ONLINE' | 'OFFLINE' | 'NEVER_SEEN' | 'UNKNOWN';

type TelemetryItem = Record<string, unknown>;

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

  async findFleet(organizationId?: string) {
    const devices = await this.deviceRepository.findAllCamerasWithSite(
      organizationId,
    );

    let items: TelemetryItem[];

    try {
      items = await this.readFleetItems(
        devices.map((device) => ({
          site_id: device.siteId,
          camera_id: device.id,
        })),
      );
    } catch (error) {
      this.handleStorageError(error);
    }

    const telemetryByDevice = new Map(
      items!.map((item) => [
        this.telemetryKey(
          this.toString(item.site_id),
          this.toString(item.camera_id),
        ),
        item,
      ]),
    );

    const fleet = devices.map((device) => {
      const item = telemetryByDevice.get(
        this.telemetryKey(device.siteId, device.id),
      );

      return this.buildResponse(device, item);
    });

    const counts: Record<ConnectivityState, number> = {
      ONLINE: 0,
      OFFLINE: 0,
      NEVER_SEEN: 0,
      UNKNOWN: 0,
    };

    for (const device of fleet) {
      counts[device.connectivity.state] += 1;
    }

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        total: fleet.length,
        online: counts.ONLINE,
        offline: counts.OFFLINE,
        neverSeen: counts.NEVER_SEEN,
        unknown: counts.UNKNOWN,
      },
      devices: fleet,
    };
  }

  async findByDeviceId(
    id: string,
    organizationId?: string,
  ) {
    const device = await this.deviceRepository.findByIdWithSite(
      id,
      organizationId,
    );

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (device.deviceType !== 'CAMERA') {
      throw new BadRequestException(
        'Telemetry is currently available only for camera devices',
      );
    }

    let item: TelemetryItem | undefined;

    try {
      const response = await this.documentClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: {
            site_id: device.siteId,
            camera_id: device.id,
          },
        }),
      );

      item = response.Item;
    } catch (error) {
      this.handleStorageError(error);
    }

    return this.buildResponse(device, item);
  }

  private async readFleetItems(
    keys: Array<Record<string, string>>,
  ): Promise<TelemetryItem[]> {
    const items: TelemetryItem[] = [];

    for (let index = 0; index < keys.length; index += 100) {
      let pendingKeys = keys.slice(index, index + 100);

      for (
        let attempt = 0;
        attempt < 3 && pendingKeys.length > 0;
        attempt += 1
      ) {
        const response = await this.documentClient.send(
          new BatchGetCommand({
            RequestItems: {
              [this.tableName]: {
                Keys: pendingKeys,
              },
            },
          }),
        );

        items.push(...(response.Responses?.[this.tableName] ?? []));

        pendingKeys =
          (response.UnprocessedKeys?.[this.tableName]?.Keys as Array<
            Record<string, string>
          >) ?? [];
      }

      if (pendingKeys.length > 0) {
        this.logger.warn(
          `${pendingKeys.length} telemetry records were not returned by DynamoDB`,
        );
      }
    }

    return items;
  }

  private buildResponse(device: DeviceWithSite, item?: TelemetryItem) {
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

  private telemetryKey(siteId: string | null, cameraId: string | null): string {
    return `${siteId ?? ''}:${cameraId ?? ''}`;
  }

  private handleStorageError(error: unknown): never {
    this.logger.error(
      'Unable to read device telemetry from DynamoDB',
      error instanceof Error ? error.stack : String(error),
    );

    throw new ServiceUnavailableException('Telemetry storage is unavailable');
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
