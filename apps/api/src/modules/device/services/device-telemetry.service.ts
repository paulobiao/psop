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
import {
  DEFAULT_CAPABILITIES,
  type CollectionState,
  type OperationalCapabilities,
  type RecordingCapabilityState,
  type ReasonRef,
  type StorageCapabilityState,
} from '../domain/operational-health.types.js';
import { TelemetryDemoService } from './telemetry-demo.service.js';
import { LocalTelemetryService } from './local-telemetry.service.js';
import { RecorderObservationService } from './recorder-observation.service.js';

type TelemetryItem = Record<string, unknown>;

const COLLECTION_STATES = new Set<CollectionState>([
  'COMPLETE',
  'PARTIAL',
  'FAILED',
  'NOT_APPLICABLE',
]);

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

    let collectionIssues = 0;
    let partialCollection = 0;

    for (const device of fleet) {
      counts[device.connectivity.state] += 1;

      if (device.collection.issues.length > 0) {
        collectionIssues += 1;
      }

      if (
        device.collection.state === 'PARTIAL' ||
        device.collection.state === 'FAILED'
      ) {
        partialCollection += 1;
      }
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
        // Diagnostics only — collection quality never opens incidents.
        collectionIssues,
        partialCollection,
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

    const isRecorderObserved =
      device.monitoringMode === 'VIA_GATEWAY';

    const capabilities = this.deriveCapabilities(
      device,
      item,
      isRecorderObserved,
    );

    const evaluation =
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
            isRecorderObserved &&
            this.toString(
              item?.individual_verification,
            ) === 'RECORDER_VERIFIED',
          temperatureC,
          storageUsedPct,
          staleTelemetryIsUnknown:
            this.toString(
              item?.observation_source,
            ) === 'RECORDER',
          isRecorderObserved,
          observerDeviceId:
            this.toString(item?.observer_device_id),
          channelNumber:
            this.toNumber(item?.channel_number),
          collectionState:
            this.toCollectionState(item?.collection_state),
          collectionIssues:
            this.toReasonRefs(item?.collection_issues),
          capabilities,
        });

    const health = evaluation.connectivity;
    const reasons = evaluation.connectivity.legacyReasons;

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
        // Compatibility alias (5 values incl. DEGRADED) for the frozen
        // dashboard. The true connectivity dimension is `linkState`.
        state: health.state,
        linkState: health.linkState,
        reasons,
        reasonRefs: health.reasons,
        lastHeartbeatAt:
          health.lastHeartbeatAt,
        lastObservedAt:
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
      health: {
        state: evaluation.health.state,
        reasons: evaluation.health.reasons,
      },
      collection: {
        state: evaluation.collection.state,
        issues: evaluation.collection.issues,
      },
      capabilities: evaluation.capabilities,
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
            details:
              this.toObject(
                item.details,
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

  private toObject(
    value: unknown,
  ): Record<string, unknown> | null {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private toString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private toCollectionState(
    value: unknown,
  ): CollectionState | null {
    return typeof value === 'string' &&
      COLLECTION_STATES.has(value as CollectionState)
      ? (value as CollectionState)
      : null;
  }

  private toReasonRefs(value: unknown): ReasonRef[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.flatMap((entry) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as { code?: unknown }).code !== 'string'
      ) {
        return [];
      }

      const raw = entry as Record<string, unknown>;

      return [
        {
          code: raw.code as ReasonRef['code'],
          source:
            typeof raw.source === 'string'
              ? (raw.source as ReasonRef['source'])
              : 'ADAPTER',
          detail:
            typeof raw.detail === 'string' ? raw.detail : null,
          observerDeviceId:
            typeof raw.observerDeviceId === 'string'
              ? raw.observerDeviceId
              : null,
          channelNumber:
            typeof raw.channelNumber === 'number'
              ? raw.channelNumber
              : null,
        },
      ];
    });
  }

  /**
   * Storage / recording capability snapshot. Preference order:
   *  1. explicit `capabilities` object reported by the adapter
   *  2. derived from recorder `details.storageState` (direct RECORDER)
   *  3. derived from a recorder-observed child's `recording_status`
   *  4. NOT_APPLICABLE default (plain camera / gateway)
   */
  private deriveCapabilities(
    device: DeviceWithSite,
    item: TelemetryItem | undefined,
    isRecorderObserved: boolean,
  ): OperationalCapabilities {
    const explicit = this.toObject(item?.capabilities);

    if (explicit) {
      return this.normalizeCapabilities(explicit);
    }

    const details = this.toObject(item?.details);
    const storageState = this.toString(details?.storageState);

    if (storageState) {
      const present = storageState === 'PRESENT';
      const storageCapabilityState: StorageCapabilityState =
        storageState === 'PRESENT'
          ? 'PRESENT'
          : storageState === 'NOT_INSTALLED'
            ? 'NOT_INSTALLED'
            : 'UNKNOWN';

      return {
        storage: {
          supported: true,
          present,
          state: storageCapabilityState,
        },
        recording: {
          state: present
            ? 'UNKNOWN'
            : storageState === 'NOT_INSTALLED'
              ? 'NOT_AVAILABLE_NO_STORAGE'
              : 'UNKNOWN',
        },
      };
    }

    if (isRecorderObserved) {
      return {
        storage: {
          supported: false,
          present: false,
          state: 'NOT_APPLICABLE',
        },
        recording: {
          state: this.toRecordingState(
            this.toString(item?.recording_status),
          ),
        },
      };
    }

    return DEFAULT_CAPABILITIES;
  }

  private normalizeCapabilities(
    raw: Record<string, unknown>,
  ): OperationalCapabilities {
    const storage = this.toObject(raw.storage);
    const recording = this.toObject(raw.recording);

    const storageState = this.toString(storage?.state);
    const present = storage?.present === true;

    return {
      storage: {
        supported: storage?.supported === true || Boolean(storageState),
        present,
        state:
          storageState === 'PRESENT' ||
          storageState === 'NOT_INSTALLED' ||
          storageState === 'UNKNOWN' ||
          storageState === 'NOT_APPLICABLE'
            ? (storageState as StorageCapabilityState)
            : present
              ? 'PRESENT'
              : 'NOT_APPLICABLE',
      },
      recording: {
        state: this.normalizeRecordingState(
          this.toString(recording?.state),
        ),
      },
    };
  }

  private toRecordingState(
    raw: string | null,
  ): RecordingCapabilityState {
    if (!raw) {
      return 'NOT_APPLICABLE';
    }

    if (raw === 'NOT_AVAILABLE_NO_STORAGE') {
      return 'NOT_AVAILABLE_NO_STORAGE';
    }

    if (
      raw === 'AVAILABLE' ||
      raw === 'recording' ||
      raw === 'recordingNormal'
    ) {
      return 'AVAILABLE';
    }

    if (raw === 'ABNORMAL' || raw === 'recordingAbnormal') {
      return 'ABNORMAL';
    }

    return 'UNKNOWN';
  }

  private normalizeRecordingState(
    raw: string | null,
  ): RecordingCapabilityState {
    switch (raw) {
      case 'AVAILABLE':
      case 'ABNORMAL':
      case 'NOT_AVAILABLE_NO_STORAGE':
      case 'UNKNOWN':
      case 'NOT_APPLICABLE':
        return raw;
      default:
        return this.toRecordingState(raw);
    }
  }
}
