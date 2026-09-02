import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  Prisma,
} from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type {
  IngestDeviceTelemetryDto,
} from '../dto/ingest-device-telemetry.dto.js';
import type {
  DeviceWithSite,
} from '../repositories/device.repository.js';

type LocalEvent =
  Prisma.DeviceConnectivityEventGetPayload<{
    include: {
      device: {
        include: {
          site: true;
        };
      };
    };
  }>;

@Injectable()
export class LocalTelemetryService {
  private readonly enabled: boolean;

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const raw =
      configService.get<string>(
        'LOCAL_TELEMETRY_INGESTION_ENABLED',
      ) ?? 'false';

    this.enabled = ['true', '1', 'yes', 'on']
      .includes(raw.toLowerCase());
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  assertEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        'Local telemetry ingestion is disabled',
      );
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      storage: 'POSTGRESQL',
      authentication: 'DEVICE_KEY',
    };
  }

  upsertSnapshot(
    deviceId: string,
    input: IngestDeviceTelemetryDto,
  ) {
    this.assertEnabled();

    const details =
      input.details === undefined
        ? undefined
        : input.details as Prisma.InputJsonValue;

    const collectionIssues =
      input.collectionIssues === undefined
        ? undefined
        : (input.collectionIssues as unknown as Prisma.InputJsonValue);

    const capabilities =
      input.capabilities === undefined
        ? undefined
        : (input.capabilities as unknown as Prisma.InputJsonValue);

    return this.prisma.deviceTelemetrySnapshot.upsert({
      where: { deviceId },
      update: {
        observedAt: new Date(input.timestamp * 1000),
        receivedAt: new Date(),
        reportedStatus: input.status,
        temperatureC: input.temperatureC,
        bitrateKbps: input.bitrateKbps,
        storageUsedPct: input.storageUsedPct,
        uptimeSeconds: input.uptimeSeconds,
        model: input.model,
        firmware: input.firmware,
        details,
        collectionState: input.collectionState ?? null,
        collectionIssues,
        capabilities,
      },
      create: {
        deviceId,
        observedAt: new Date(input.timestamp * 1000),
        reportedStatus: input.status,
        temperatureC: input.temperatureC,
        bitrateKbps: input.bitrateKbps,
        storageUsedPct: input.storageUsedPct,
        uptimeSeconds: input.uptimeSeconds,
        model: input.model,
        firmware: input.firmware,
        details,
        collectionState: input.collectionState ?? null,
        collectionIssues,
        capabilities,
      },
    });
  }

  async findFleetItems(
    devices: DeviceWithSite[],
  ): Promise<Record<string, unknown>[]> {
    const snapshots =
      await this.prisma.deviceTelemetrySnapshot.findMany({
        where: {
          deviceId: {
            in: devices.map((device) => device.id),
          },
        },
      });

    const devicesById = new Map(
      devices.map((device) => [device.id, device]),
    );

    return snapshots.flatMap((snapshot) => {
      const device = devicesById.get(snapshot.deviceId);

      return device
        ? [this.toTelemetryItem(snapshot, device)]
        : [];
    });
  }

  async findItem(
    device: DeviceWithSite,
  ): Promise<Record<string, unknown> | undefined> {
    const snapshot =
      await this.prisma.deviceTelemetrySnapshot.findUnique({
        where: { deviceId: device.id },
      });

    return snapshot
      ? this.toTelemetryItem(snapshot, device)
      : undefined;
  }

  async storeEvent(event: Record<string, unknown>) {
    const context =
      event.context === undefined
        ? undefined
        : (event.context as Prisma.InputJsonValue);

    const created =
      await this.prisma.deviceConnectivityEvent.create({
        data: {
          deviceId: String(event.device_id),
          eventType: String(event.event_type),
          previousState:
            typeof event.previous_state === 'string'
              ? event.previous_state
              : null,
          currentState: String(event.current_state),
          detectedAt: new Date(String(event.detected_at)),
          lastHeartbeatAt:
            typeof event.last_heartbeat_at === 'string'
              ? new Date(event.last_heartbeat_at)
              : null,
          ageSeconds:
            typeof event.age_seconds === 'number'
              ? event.age_seconds
              : null,
          expiresAt:
            typeof event.expires_at === 'number'
              ? new Date(event.expires_at * 1000)
              : null,
          context,
        },
        include: {
          device: {
            include: {
              site: true,
            },
          },
        },
      });

    return this.toEvent(created);
  }

  async findRecentEvents(
    deviceIds: string[] | undefined,
    limit: number,
  ) {
    const events =
      await this.prisma.deviceConnectivityEvent.findMany({
        where: deviceIds
          ? { deviceId: { in: deviceIds } }
          : undefined,
        include: {
          device: {
            include: {
              site: true,
            },
          },
        },
        orderBy: { detectedAt: 'desc' },
        take: limit,
      });

    return events.map((event) => this.toEvent(event));
  }

  async findEventsByDevice(
    deviceId: string,
    limit: number,
  ) {
    const events =
      await this.prisma.deviceConnectivityEvent.findMany({
        where: { deviceId },
        include: {
          device: {
            include: {
              site: true,
            },
          },
        },
        orderBy: { detectedAt: 'desc' },
        take: limit,
      });

    return events.map((event) => this.toEvent(event));
  }

  /**
   * The most recent connectivity transitions for one device (newest first),
   * bounded by `since` and `cap`. Used to reconstruct the start of a
   * currently-open outage independently of any availability window.
   */
  async findRecentEventsByDevice(
    deviceId: string,
    since: Date,
    cap: number,
  ) {
    const events =
      await this.prisma.deviceConnectivityEvent.findMany({
        where: {
          deviceId,
          detectedAt: { gte: since },
        },
        include: {
          device: {
            include: {
              site: true,
            },
          },
        },
        orderBy: { detectedAt: 'desc' },
        take: cap,
      });

    return events.map((event) => this.toEvent(event));
  }

  async findLatestEvent(deviceId: string) {
    const event =
      await this.prisma.deviceConnectivityEvent.findFirst({
        where: { deviceId },
        include: {
          device: {
            include: {
              site: true,
            },
          },
        },
        orderBy: { detectedAt: 'desc' },
      });

    return event ? this.toEvent(event) : undefined;
  }

  /**
   * Every connectivity transition the device recorded inside `[start, end]`
   * (ascending), plus the single latest transition strictly before `start` —
   * the "anchor" that tells the availability reconstruction which state the
   * device was already in when the window opened.
   */
  async findEventsInWindow(
    deviceId: string,
    start: Date,
    end: Date,
    cap: number,
  ) {
    const include = {
      device: {
        include: {
          site: true,
        },
      },
    } as const;

    const [inWindow, anchor] = await Promise.all([
      this.prisma.deviceConnectivityEvent.findMany({
        where: {
          deviceId,
          detectedAt: { gte: start, lte: end },
        },
        include,
        orderBy: { detectedAt: 'asc' },
        take: cap,
      }),
      this.prisma.deviceConnectivityEvent.findFirst({
        where: {
          deviceId,
          detectedAt: { lt: start },
        },
        include,
        orderBy: { detectedAt: 'desc' },
      }),
    ]);

    return {
      events: inWindow.map((event) => this.toEvent(event)),
      anchor: anchor ? this.toEvent(anchor) : null,
    };
  }

  private toTelemetryItem(
    snapshot: {
      observedAt: Date;
      reportedStatus: string | null;
      temperatureC: number | null;
      bitrateKbps: number | null;
      storageUsedPct: number | null;
      uptimeSeconds: number | null;
      model: string | null;
      firmware: string | null;
      details: Prisma.JsonValue | null;
      collectionState: string | null;
      collectionIssues: Prisma.JsonValue | null;
      capabilities: Prisma.JsonValue | null;
    },
    device: DeviceWithSite,
  ) {
    return {
      camera_id: device.id,
      site_id: device.siteId,
      external_id: device.externalId,
      timestamp: Math.floor(
        snapshot.observedAt.getTime() / 1000,
      ),
      iso_time: snapshot.observedAt.toISOString(),
      status: snapshot.reportedStatus,
      temperature_c: snapshot.temperatureC,
      bitrate_kbps: snapshot.bitrateKbps,
      storage_used_pct: snapshot.storageUsedPct,
      uptime_seconds: snapshot.uptimeSeconds,
      model: snapshot.model ?? device.model,
      firmware:
        snapshot.firmware ?? device.firmwareVersion,
      details: snapshot.details,
      collection_state: snapshot.collectionState,
      collection_issues: snapshot.collectionIssues,
      capabilities: snapshot.capabilities,
    };
  }

  private toEvent(event: LocalEvent) {
    return {
      camera_id: event.deviceId,
      timestamp: event.detectedAt.getTime(),
      event_type: event.eventType,
      device_id: event.deviceId,
      device_name: event.device.name,
      site_id: event.device.siteId,
      external_id: event.device.externalId,
      previous_state: event.previousState,
      current_state: event.currentState,
      detected_at: event.detectedAt.toISOString(),
      last_heartbeat_at:
        event.lastHeartbeatAt?.toISOString() ?? null,
      age_seconds: event.ageSeconds,
      expires_at: event.expiresAt
        ? Math.floor(event.expiresAt.getTime() / 1000)
        : null,
      context: event.context,
    };
  }
}
