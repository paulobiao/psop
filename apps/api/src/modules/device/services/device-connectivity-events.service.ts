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
import type { ConnectivityContext } from '../../alert/types/connectivity-context.type.js';
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

  /** Safety cap on how many transition rows one availability query will page. */
  private static readonly EVENT_WINDOW_CAP = 5000;

  /**
   * Upper bound on how many recent transitions are scanned to reconstruct the
   * start of a currently-open outage. The monitor only writes on state change,
   * so an OFFLINE run is normally 1–2 rows; this is deliberately generous.
   */
  private static readonly CURRENT_OUTAGE_SCAN_CAP = 500;

  private readonly tableName: string;
  private readonly retentionDays: number;
  private readonly documentClient: DynamoDBDocumentClient;
  private readonly demoEvents =
    new Map<string, Record<string, unknown>[]>();

  /**
   * Deterministic anti-flapping guard. Keyed by device id, it counts how many
   * consecutive evaluations have shown a debounced OFFLINE before the
   * transition is committed. In-memory on purpose: a process restart just
   * re-arms the guard (conservative), and it introduces no timers/sleeps.
   */
  private readonly flapGuard =
    new Map<string, { state: string; count: number }>();

  private readonly flapMinConsecutive: number;

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

    const flapRaw = Number(
      configService.get<string>('CONNECTIVITY_FLAP_MIN_CONSECUTIVE') ?? '1',
    );
    this.flapMinConsecutive =
      Number.isFinite(flapRaw) && flapRaw >= 1
        ? Math.floor(flapRaw)
        : 1;

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

    const deviceNameById = new Map(
      fleet.devices.map((snapshot) => [
        snapshot.device.id,
        snapshot.device.name,
      ]),
    );

    try {
      for (const snapshot of fleet.devices) {
        const partitionKey = snapshot.device.id;

        const previous = await this.findLatestEvent(partitionKey);
        const previousState = this.toString(previous?.current_state);
        const currentState = snapshot.connectivity.state;

        const context = this.buildContext(snapshot, deviceNameById);

        if (currentState !== 'OFFLINE') {
          this.flapGuard.delete(partitionKey);
        }

        if (previousState === currentState) {
          if (currentState !== 'ONLINE') {
            await this.alertService.touchConnectivityAlert(
              snapshot.device.id,
              context,
            );
          }

          continue;
        }

        if (
          this.flapMinConsecutive > 1 &&
          this.isDebouncedOfflineTransition(
            snapshot,
            previousState,
            currentState,
          )
        ) {
          const pending = this.flapGuard.get(partitionKey);
          const count =
            pending?.state === currentState ? pending.count + 1 : 1;

          this.flapGuard.set(partitionKey, {
            state: currentState,
            count,
          });

          if (count < this.flapMinConsecutive) {
            // Not yet confirmed — hold the previous state for this cycle.
            continue;
          }
        }

        this.flapGuard.delete(partitionKey);

        await this.synchronizeAlert(snapshot, context);

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
          context,
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

  /**
   * Raw connectivity-transition history for one device, used by the
   * availability reconstruction. Returns the transitions inside
   * `[windowStart, windowEnd]` (ascending) plus the single latest transition
   * strictly before `windowStart` (the "anchor" state).
   *
   * This method does NOT authorise the caller — `DeviceAvailabilityService`
   * has already resolved the device inside the caller's organization.
   */
  async collectEventWindow(
    deviceId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<{
    anchor: Record<string, unknown> | null;
    events: Record<string, unknown>[];
    truncated: boolean;
  }> {
    const cap = DeviceConnectivityEventsService.EVENT_WINDOW_CAP;

    if (this.telemetryDemoService.isEnabled()) {
      // demoEvents is stored newest-first, capped at 50.
      const all = [...(this.demoEvents.get(deviceId) ?? [])].sort(
        (first, second) =>
          this.toTimestamp(first.timestamp) -
          this.toTimestamp(second.timestamp),
      );

      const startMs = windowStart.getTime();
      const endMs = windowEnd.getTime();

      const events = all.filter((event) => {
        const ts = this.toTimestamp(event.timestamp);
        return ts >= startMs && ts <= endMs;
      });

      const anchor =
        [...all]
          .reverse()
          .find(
            (event) => this.toTimestamp(event.timestamp) < startMs,
          ) ?? null;

      return { anchor, events, truncated: false };
    }

    if (this.localTelemetryService.isEnabled()) {
      const { anchor, events } =
        await this.localTelemetryService.findEventsInWindow(
          deviceId,
          windowStart,
          windowEnd,
          cap + 1,
        );

      const truncated = events.length > cap;

      return {
        anchor,
        events: truncated ? events.slice(0, cap) : events,
        truncated,
      };
    }

    try {
      const inWindow: Record<string, unknown>[] = [];
      let exclusiveStartKey:
        | Record<string, unknown>
        | undefined;

      do {
        const response = await this.documentClient.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression:
              'camera_id = :cameraId AND #ts BETWEEN :start AND :end',
            ExpressionAttributeNames: {
              '#ts': 'timestamp',
            },
            ExpressionAttributeValues: {
              ':cameraId': deviceId,
              ':start': windowStart.getTime(),
              ':end': windowEnd.getTime(),
            },
            ScanIndexForward: true,
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );

        inWindow.push(...(response.Items ?? []));
        exclusiveStartKey = response.LastEvaluatedKey;
      } while (exclusiveStartKey && inWindow.length <= cap);

      const anchorResponse = await this.documentClient.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression:
            'camera_id = :cameraId AND #ts < :start',
          ExpressionAttributeNames: {
            '#ts': 'timestamp',
          },
          ExpressionAttributeValues: {
            ':cameraId': deviceId,
            ':start': windowStart.getTime(),
          },
          ScanIndexForward: false,
          Limit: 1,
        }),
      );

      const truncated = inWindow.length > cap;

      return {
        anchor: anchorResponse.Items?.[0] ?? null,
        events: truncated ? inWindow.slice(0, cap) : inWindow,
        truncated,
      };
    } catch (error) {
      this.handleStorageError(error);
    }
  }

  /**
   * The most recent connectivity transitions for one device (newest first),
   * within the retention horizon and capped at `CURRENT_OUTAGE_SCAN_CAP`. Used
   * by `DeviceAvailabilityService` to reconstruct where the *currently open*
   * outage began, independently of any requested availability window.
   *
   * Read-only. The caller (`DeviceAvailabilityService`) has already resolved
   * the device inside the caller's organization.
   */
  async findRecentTransitions(
    deviceId: string,
    now: Date,
  ): Promise<Record<string, unknown>[]> {
    const cap = DeviceConnectivityEventsService.CURRENT_OUTAGE_SCAN_CAP;
    const since = new Date(
      now.getTime() - this.retentionDays * 86400 * 1000,
    );
    const sinceMs = since.getTime();

    if (this.telemetryDemoService.isEnabled()) {
      return [...(this.demoEvents.get(deviceId) ?? [])]
        .filter((event) => this.toTimestamp(event.timestamp) >= sinceMs)
        .sort(
          (first, second) =>
            this.toTimestamp(second.timestamp) -
            this.toTimestamp(first.timestamp),
        )
        .slice(0, cap);
    }

    if (this.localTelemetryService.isEnabled()) {
      return this.localTelemetryService.findRecentEventsByDevice(
        deviceId,
        since,
        cap,
      );
    }

    try {
      const items: Record<string, unknown>[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;

      do {
        const response = await this.documentClient.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression:
              'camera_id = :cameraId AND #ts >= :since',
            ExpressionAttributeNames: {
              '#ts': 'timestamp',
            },
            ExpressionAttributeValues: {
              ':cameraId': deviceId,
              ':since': sinceMs,
            },
            ScanIndexForward: false,
            Limit: cap,
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );

        items.push(...(response.Items ?? []));
        exclusiveStartKey = response.LastEvaluatedKey;
      } while (exclusiveStartKey && items.length < cap);

      return items.slice(0, cap);
    } catch (error) {
      this.handleStorageError(error);
    }
  }

  private async synchronizeAlert(
    snapshot: Awaited<
      ReturnType<DeviceTelemetryService['findFleet']>
    >['devices'][number],
    context: ConnectivityContext,
  ): Promise<void> {
    if (snapshot.connectivity.state === 'ONLINE') {
      await this.alertService.resolveConnectivityAlert(
        snapshot.device.id,
        'ONLINE',
        context,
      );
      return;
    }

    await this.alertService.openConnectivityAlert({
      deviceId: snapshot.device.id,
      deviceName: snapshot.device.name,
      siteCode: snapshot.device.siteCode,
      externalId: snapshot.device.externalId,
      state: snapshot.connectivity.state,
      context,
    });
  }

  /**
   * Anti-flapping applies ONLY to a direct device going OFFLINE because its
   * heartbeat is overdue. Recorder-verified / authoritative reported OFFLINE
   * keeps its immediate response — the recorder is an authoritative source.
   */
  private isDebouncedOfflineTransition(
    snapshot: Awaited<
      ReturnType<DeviceTelemetryService['findFleet']>
    >['devices'][number],
    previousState: string | null,
    currentState: string,
  ): boolean {
    if (currentState !== 'OFFLINE') {
      return false;
    }

    if (previousState === 'OFFLINE') {
      return false;
    }

    if (snapshot.monitoring.source !== 'DIRECT') {
      return false;
    }

    const reasons = snapshot.connectivity.reasons;

    return (
      reasons.includes('HEARTBEAT_OVERDUE') &&
      !reasons.includes('REPORTED_OFFLINE') &&
      !reasons.includes('RECORDER_VERIFIED_OFFLINE')
    );
  }

  private buildContext(
    snapshot: Awaited<
      ReturnType<DeviceTelemetryService['findFleet']>
    >['devices'][number],
    deviceNameById: Map<string, string>,
  ): ConnectivityContext {
    const observerDeviceId = snapshot.monitoring.observerDeviceId;

    const linkState = snapshot.connectivity.linkState;
    const healthState = snapshot.health.state;

    const dimension: 'CONNECTIVITY' | 'HEALTH' =
      linkState === 'ONLINE' &&
      (healthState === 'DEGRADED' || healthState === 'CRITICAL')
        ? 'HEALTH'
        : 'CONNECTIVITY';

    return {
      reasons: snapshot.connectivity.reasons,
      monitoringSource: snapshot.monitoring.source,
      individualVerification: snapshot.monitoring.individualVerification,
      observerDeviceId,
      observerDeviceName: observerDeviceId
        ? deviceNameById.get(observerDeviceId) ?? null
        : null,
      channelId: snapshot.telemetry?.channelId ?? null,
      channelNumber: snapshot.telemetry?.channelNumber ?? null,
      lastHeartbeatAt: snapshot.connectivity.lastHeartbeatAt,
      ageSeconds: snapshot.connectivity.ageSeconds,
      dimension,
      linkState,
      healthState,
      healthReasons: snapshot.health.reasons.map((reason) => reason.code),
      collectionState: snapshot.collection.state,
      collectionIssues: snapshot.collection.issues.map(
        (issue) => issue.code,
      ),
    };
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
