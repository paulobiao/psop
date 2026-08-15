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
import {
  DeviceHealthService,
  type ConnectivityState,
} from './device-health.service.js';
import { TelemetryDemoService } from './telemetry-demo.service.js';
import { LocalTelemetryService } from './local-telemetry.service.js';
import { RecorderObservationService } from './recorder-observation.service.js';

type TelemetryItem = Record<string, unknown>;

@Injectable()
export class DeviceTelemetryService {
  private readonly logger = new Logger(DeviceTelemetryService.name);
  private readonly tableName: string;
  private readonly documentClient: DynamoDBDocumentClient;

  constructor(
    configService: ConfigService,
    private readonly deviceRepository: DeviceRepository,
    private readonly deviceHealthService: DeviceHealthService,
    private readonly telemetryDemoService: TelemetryDemoService,
    private readonly localTelemetryService: LocalTelemetryService,
    private readonly recorderObservationService: RecorderObservationService,
  ) {
    const region = configService.get<string>('AWS_REGION') ?? 'us-east-1';

    this.tableName =
      configService.get<string>('DYNAMODB_STATUS_TABLE') ??
      'camera-fleet-monitor-status';


    this.documentClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region,
      }),
    );
  }

  async findFleet(organizationId?: string) {
    const devices =
      await this.deviceRepository
        .findAllObservableDevicesWithSite(
          organizationId,
        );

    const directDevices = devices.filter(
      (device) =>
        device.monitoringMode === 'DIRECT',
    );

    const recorderObservedDevices = devices.filter(
      (device) =>
        device.monitoringMode === 'VIA_GATEWAY',
    );

    let directItems: TelemetryItem[];

    if (
      this.telemetryDemoService
        .isEnabled()
    ) {
      directItems = directDevices
        .map((device) =>
          this.telemetryDemoService
            .getItem(device),
        )
        .filter(
          (
            item,
          ): item is TelemetryItem =>
            Boolean(item),
        );
    } else if (
      this.localTelemetryService.isEnabled()
    ) {
      directItems =
        await this.localTelemetryService
          .findFleetItems(directDevices);
    } else {
      try {
        directItems = await this.readFleetItems(
          directDevices.map((device) => ({
            site_id: device.siteId,
            camera_id: device.id,
          })),
        );
      } catch (error) {
        this.handleStorageError(error);
      }
    }

    const recorderItems =
      await this.recorderObservationService
        .findFleetItems(
          recorderObservedDevices,
        );

    const items = [
      ...directItems!,
      ...recorderItems,
    ];

    const telemetryByDevice = new Map(
      items.map((item) => [
        this.telemetryKey(
          this.toString(item.site_id),
          this.toString(item.camera_id),
        ),
        item,
      ]),
    );

    const fleet = devices.flatMap((device) => {
      const item = telemetryByDevice.get(
        this.telemetryKey(device.siteId, device.id),
      );

      if (
        device.monitoringMode === 'VIA_GATEWAY' &&
        !item
      ) {
        return [];
      }

      return [
        this.buildResponse(device, item),
      ];
    });

    const counts: Record<ConnectivityState, number> = {
      ONLINE: 0,
      DEGRADED: 0,
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
        degraded: counts.DEGRADED,
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

    const isDirect =
      device.monitoringMode === 'DIRECT' &&
      ['CAMERA', 'RECORDER', 'GATEWAY'].includes(
        device.deviceType,
      );

    const isRecorderObserved =
      device.monitoringMode === 'VIA_GATEWAY' &&
      device.deviceType === 'CAMERA' &&
      Boolean(device.gatewayDeviceId);

    if (!isDirect && !isRecorderObserved) {
      throw new BadRequestException(
        'Telemetry is available only for directly monitored devices or recorder-observed cameras',
      );
    }

    let item: TelemetryItem | undefined;

    if (isRecorderObserved) {
      item =
        await this.recorderObservationService
          .findItem(device);
    } else if (
      this.telemetryDemoService
        .isEnabled()
    ) {
      item =
        this.telemetryDemoService
          .getItem(device);
    } else if (
      this.localTelemetryService.isEnabled()
    ) {
      item =
        await this.localTelemetryService
          .findItem(device);
    } else {
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

  private buildResponse(
    device: DeviceWithSite,
    item?: TelemetryItem,
  ) {
    const timestamp =
      this.toNumber(item?.timestamp);

    const reportedStatus =
      this.toString(item?.status);

    const temperatureC =
      this.toNumber(
        item?.temperature_c,
      );

    const storageUsedPct =
      this.toNumber(
        item?.storage_used_pct,
      );

    const health =
      this.deviceHealthService
        .evaluate({
          hasTelemetry:
            Boolean(item),
          timestampSeconds:
            timestamp,
          expectedHeartbeatIntervalSeconds:
            device
              .expectedHeartbeatInterval,
          reportedStatus,
          reportedOfflineIsAuthoritative:
            device.monitoringMode === 'VIA_GATEWAY' &&
            this.toString(
              item?.individual_verification,
            ) === 'RECORDER_VERIFIED',
          temperatureC,
          storageUsedPct,
          staleTelemetryIsUnknown:
            this.toString(
              item?.observation_source,
            ) === 'RECORDER',
        });

    return {
      device: {
        id: device.id,
        name: device.name,
        externalId:
          device.externalId,
        deviceType:
          device.deviceType,
        monitoringMode:
          device.monitoringMode,
        gatewayDeviceId:
          device.gatewayDeviceId,
        administrativeStatus:
          device.status,
        siteId: device.siteId,
        siteCode:
          device.site.code,
        siteName:
          device.site.name,
      },
      monitoring: {
        source:
          device.monitoringMode === 'DIRECT'
            ? 'DIRECT'
            : this.toString(item?.observation_source) ===
                'RECORDER'
              ? 'RECORDER_OBSERVED'
              : 'GATEWAY_DERIVED',
        individualVerification:
          device.monitoringMode === 'DIRECT'
            ? 'DIRECT'
            : this.toString(
                  item?.individual_verification,
                ) === 'RECORDER_VERIFIED'
              ? 'RECORDER_VERIFIED'
              : 'NOT_VERIFIED',
        observerDeviceId:
          this.toString(
            item?.observer_device_id,
          ),
      },
      connectivity: {
        state: health.state,
        reasons: health.reasons,
        lastHeartbeatAt:
          health.lastHeartbeatAt,
        ageSeconds:
          health.ageSeconds,
        expectedHeartbeatIntervalSeconds:
          device
            .expectedHeartbeatInterval,
        offlineAfterSeconds:
          health
            .offlineAfterSeconds,
      },
      telemetry: item
        ? {
            reportedStatus,
            temperatureC,
            bitrateKbps:
              this.toNumber(
                item.bitrate_kbps,
              ),
            storageUsedPct,
            uptimeSeconds:
              this.toNumber(
                item.uptime_seconds,
              ),
            model:
              this.toString(
                item.model,
              ),
            firmware:
              this.toString(
                item.firmware,
              ),
            isoTime:
              this.toString(
                item.iso_time,
              ),
            channelId:
              this.toString(
                item.channel_id,
              ),
            channelNumber:
              this.toNumber(
                item.channel_number,
              ),
            poePort:
              this.toNumber(
                item.poe_port,
              ),
            poePowerW:
              this.toNumber(
                item.poe_power_w,
              ),
            recordingStatus:
              this.toString(
                item.recording_status,
              ),
            protocol:
              this.toString(
                item.protocol,
              ),
            resolution:
              this.toString(
                item.resolution,
              ),
            frameRate:
              this.toNumber(
                item.frame_rate,
              ),
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
