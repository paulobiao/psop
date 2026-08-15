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
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { AlertService } from '../../alert/services/alert.service.js';
import {
  DeviceRepository,
  DeviceWithSite,
} from '../repositories/device.repository.js';
import { DeviceTelemetryService } from './device-telemetry.service.js';
import { TelemetryDemoService } from './telemetry-demo.service.js';
import { LocalTelemetryService } from './local-telemetry.service.js';

@Injectable()
export class DeviceConnectivityEventsService {
  private readonly logger = new Logger(DeviceConnectivityEventsService.name);

  private readonly tableName: string;
  private readonly retentionDays: number;
  private readonly documentClient: DynamoDBDocumentClient;
  private readonly demoEvents =
    new Map<string, Record<string, unknown>[]>();

  constructor(
    configService: ConfigService,
    private readonly deviceRepository: DeviceRepository,
    private readonly telemetryService: DeviceTelemetryService,
    private readonly alertService: AlertService,
    private readonly telemetryDemoService: TelemetryDemoService,
    private readonly localTelemetryService: LocalTelemetryService,
  ) {
    const region = configService.get<string>('AWS_REGION') ?? 'us-east-1';

    this.tableName =
      configService.get<string>('DYNAMODB_EVENTS_TABLE') ??
      'camera-fleet-monitor-events';

    this.retentionDays = Number(
      configService.get<string>('CONNECTIVITY_EVENT_RETENTION_DAYS') ?? '90',
    );

    this.documentClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region,
      }),
    );
  }

  async evaluateFleet(organizationId?: string) {
    const fleet = await this.telemetryService.findFleet(
      organizationId,
    );
    const events: Record<string, unknown>[] = [];

    try {
      for (const snapshot of fleet.devices) {
        const partitionKey = snapshot.device.id;

        const previous = await this.findLatestEvent(partitionKey);
        const previousState = this.toString(previous?.current_state);
        const currentState = snapshot.connectivity.state;

        await this.synchronizeAlert(snapshot);

        if (previousState === currentState) {
          continue;
        }

        const now = new Date();
        const timestamp = now.getTime();

        const event = {
          camera_id: partitionKey,
          timestamp,
          event_type: previous ? 'CONNECTIVITY_CHANGED' : 'INITIAL_STATE',
          device_id: snapshot.device.id,
          device_name: snapshot.device.name,
          site_id: snapshot.device.siteId,
          external_id: snapshot.device.externalId,
          previous_state: previousState,
          current_state: currentState,
          detected_at: now.toISOString(),
          last_heartbeat_at: snapshot.connectivity.lastHeartbeatAt,
          age_seconds: snapshot.connectivity.ageSeconds,
          expires_at: Math.floor(timestamp / 1000) + this.retentionDays * 86400,
        };

        if (
          this.telemetryDemoService
            .isEnabled()
        ) {
          this.storeDemoEvent(
            partitionKey,
            event,
          );
        } else if (
          this.localTelemetryService
            .isEnabled()
        ) {
          await this.localTelemetryService
            .storeEvent(event);
        } else {
          await this.documentClient.send(
            new PutCommand({
              TableName: this.tableName,
              Item: event,
            }),
          );
        }

        events.push(event);
      }
    } catch (error) {
      this.handleStorageError(error);
    }

    return {
      evaluatedAt: new Date().toISOString(),
      evaluatedDevices: fleet.devices.length,
      createdEvents: events.length,
      events,
    };
  }

  async findRecent(
    limit = 20,
    organizationId?: string,
  ) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);

    const allowedDeviceIds = organizationId
      ? new Set(
          (
            await this.deviceRepository
              .findAllObservableDevicesWithSite(
                organizationId,
              )
          ).map((device) => device.id),
        )
      : null;
    const items: Record<string, unknown>[] = [];

    if (
      this.telemetryDemoService
        .isEnabled()
    ) {
      for (
        const deviceEvents of
        this.demoEvents.values()
      ) {
        items.push(
          ...deviceEvents,
        );
      }
    } else if (
      this.localTelemetryService
        .isEnabled()
    ) {
      items.push(
        ...await this.localTelemetryService
          .findRecentEvents(
            allowedDeviceIds
              ? [...allowedDeviceIds]
              : undefined,
            1000,
          ),
      );
    } else {
      let exclusiveStartKey:
        Record<string, unknown> |
        undefined;

      try {
        do {
          const response =
            await this.documentClient.send(
              new ScanCommand({
                TableName:
                  this.tableName,
                ExclusiveStartKey:
                  exclusiveStartKey,
              }),
            );

          items.push(
            ...(response.Items ?? []),
          );

          exclusiveStartKey =
            response.LastEvaluatedKey;
        } while (
          exclusiveStartKey &&
          items.length < 1000
        );
      } catch (error) {
        this.handleStorageError(error);
      }
    }

    const scopedItems = allowedDeviceIds
      ? items.filter((item) =>
          allowedDeviceIds.has(
            this.toString(item.device_id) ?? '',
          ),
        )
      : items;

    return scopedItems
      .sort(
        (first, second) =>
          this.toTimestamp(second.timestamp) -
          this.toTimestamp(first.timestamp),
      )
      .slice(0, safeLimit);
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

    const individuallyObservable =
      (
        device.monitoringMode === 'DIRECT' &&
        ['CAMERA', 'RECORDER', 'GATEWAY'].includes(
          device.deviceType,
        )
      ) ||
      (
        device.monitoringMode === 'VIA_GATEWAY' &&
        device.deviceType === 'CAMERA' &&
        Boolean(device.gatewayDeviceId)
      );

    if (!individuallyObservable) {
      throw new BadRequestException(
        'Connectivity events are available only for directly monitored devices or recorder-observed cameras',
      );
    }

    let events: Record<string, unknown>[];

    if (
      this.telemetryDemoService
        .isEnabled()
    ) {
      events =
        this.demoEvents.get(
          device.id,
        ) ?? [];
    } else if (
      this.localTelemetryService
        .isEnabled()
    ) {
      events =
        await this.localTelemetryService
          .findEventsByDevice(
            device.id,
            50,
          );
    } else {
      try {
        const response = await this.documentClient.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'camera_id = :cameraId',
            ExpressionAttributeValues: {
              ':cameraId': device.id,
            },
            ScanIndexForward: false,
            Limit: 50,
          }),
        );

        events = response.Items ?? [];
      } catch (error) {
        this.handleStorageError(error);
      }
    }

    return {
      device: this.deviceSummary(device),
      events: events!,
    };
  }

  private async synchronizeAlert(
    snapshot: Awaited<
      ReturnType<DeviceTelemetryService['findFleet']>
    >['devices'][number],
  ): Promise<void> {
    if (snapshot.connectivity.state === 'ONLINE') {
      await this.alertService.resolveConnectivityAlert(snapshot.device.id);
      return;
    }

    await this.alertService.openConnectivityAlert({
      deviceId: snapshot.device.id,
      deviceName: snapshot.device.name,
      siteCode: snapshot.device.siteCode,
      externalId: snapshot.device.externalId,
      state: snapshot.connectivity.state,
    });
  }

  private async findLatestEvent(
    partitionKey: string,
  ): Promise<Record<string, unknown> | undefined> {
    if (
      this.telemetryDemoService
        .isEnabled()
    ) {
      return this.demoEvents
        .get(partitionKey)
        ?.at(0);
    }

    if (
      this.localTelemetryService
        .isEnabled()
    ) {
      return this.localTelemetryService
        .findLatestEvent(
          partitionKey,
        );
    }

    const response = await this.documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'camera_id = :cameraId',
        ExpressionAttributeValues: {
          ':cameraId': partitionKey,
        },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );

    return response.Items?.[0];
  }

  private storeDemoEvent(
    partitionKey: string,
    event: Record<string, unknown>,
  ): void {
    const current =
      this.demoEvents.get(
        partitionKey,
      ) ?? [];

    this.demoEvents.set(
      partitionKey,
      [
        event,
        ...current,
      ].slice(0, 50),
    );
  }

  private deviceSummary(device: DeviceWithSite) {
    return {
      id: device.id,
      name: device.name,
      externalId: device.externalId,
      siteId: device.siteId,
      siteCode: device.site.code,
      siteName: device.site.name,
    };
  }

  private handleStorageError(error: unknown): never {
    this.logger.error(
      'Unable to access connectivity events in DynamoDB',
      error instanceof Error ? error.stack : String(error),
    );

    throw new ServiceUnavailableException(
      'Connectivity event storage is unavailable',
    );
  }

  private toTimestamp(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
  }

  private toString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }
}
