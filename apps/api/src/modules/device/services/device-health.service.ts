import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type ConnectivityState =
  | 'ONLINE'
  | 'DEGRADED'
  | 'OFFLINE'
  | 'NEVER_SEEN'
  | 'UNKNOWN';

export type DeviceHealthReason =
  | 'NO_TELEMETRY'
  | 'INVALID_TIMESTAMP'
  | 'HEARTBEAT_OVERDUE'
  | 'REPORTED_STATUS_NOT_HEALTHY'
  | 'UNRECOGNIZED_REPORTED_STATUS'
  | 'HIGH_TEMPERATURE'
  | 'HIGH_STORAGE_USAGE';

export interface DeviceHealthInput {
  hasTelemetry: boolean;
  timestampSeconds: number | null;
  expectedHeartbeatIntervalSeconds: number;
  reportedStatus: string | null;
  temperatureC: number | null;
  storageUsedPct: number | null;
  nowSeconds?: number;
}

export interface DeviceHealthResult {
  state: ConnectivityState;
  reasons: DeviceHealthReason[];
  lastHeartbeatAt: string | null;
  ageSeconds: number | null;
  offlineAfterSeconds: number;
}

@Injectable()
export class DeviceHealthService {
  private readonly offlineMultiplier: number;
  private readonly degradedTemperatureC: number;
  private readonly degradedStorageUsedPct: number;

  constructor(
    configService: ConfigService,
  ) {
    this.offlineMultiplier =
      this.positiveNumber(
        configService.get<string>(
          'TELEMETRY_OFFLINE_MULTIPLIER',
        ),
        2,
      );

    this.degradedTemperatureC =
      this.positiveNumber(
        configService.get<string>(
          'TELEMETRY_DEGRADED_TEMPERATURE_C',
        ),
        70,
      );

    this.degradedStorageUsedPct =
      this.positiveNumber(
        configService.get<string>(
          'TELEMETRY_DEGRADED_STORAGE_USED_PCT',
        ),
        90,
      );
  }

  evaluate(
    input: DeviceHealthInput,
  ): DeviceHealthResult {
    const offlineAfterSeconds =
      Math.max(
        1,
        input.expectedHeartbeatIntervalSeconds,
      ) * this.offlineMultiplier;

    if (!input.hasTelemetry) {
      return {
        state: 'NEVER_SEEN',
        reasons: ['NO_TELEMETRY'],
        lastHeartbeatAt: null,
        ageSeconds: null,
        offlineAfterSeconds,
      };
    }

    if (input.timestampSeconds === null) {
      return {
        state: 'UNKNOWN',
        reasons: ['INVALID_TIMESTAMP'],
        lastHeartbeatAt: null,
        ageSeconds: null,
        offlineAfterSeconds,
      };
    }

    const nowSeconds =
      input.nowSeconds ??
      Math.floor(Date.now() / 1000);

    const ageSeconds = Math.max(
      0,
      nowSeconds -
        input.timestampSeconds,
    );

    const lastHeartbeatAt =
      new Date(
        input.timestampSeconds * 1000,
      ).toISOString();

    if (
      ageSeconds >
      offlineAfterSeconds
    ) {
      return {
        state: 'OFFLINE',
        reasons: ['HEARTBEAT_OVERDUE'],
        lastHeartbeatAt,
        ageSeconds,
        offlineAfterSeconds,
      };
    }

    const normalizedStatus =
      input.reportedStatus
        ?.trim()
        .toLowerCase() ??
      null;

    if (
      normalizedStatus &&
      !this.healthyStatuses().has(
        normalizedStatus,
      ) &&
      !this.degradedStatuses().has(
        normalizedStatus,
      )
    ) {
      return {
        state: 'UNKNOWN',
        reasons: [
          'UNRECOGNIZED_REPORTED_STATUS',
        ],
        lastHeartbeatAt,
        ageSeconds,
        offlineAfterSeconds,
      };
    }

    const reasons:
      DeviceHealthReason[] = [];

    if (
      normalizedStatus &&
      this.degradedStatuses().has(
        normalizedStatus,
      )
    ) {
      reasons.push(
        'REPORTED_STATUS_NOT_HEALTHY',
      );
    }

    if (
      input.temperatureC !== null &&
      input.temperatureC >=
        this.degradedTemperatureC
    ) {
      reasons.push(
        'HIGH_TEMPERATURE',
      );
    }

    if (
      input.storageUsedPct !== null &&
      input.storageUsedPct >=
        this.degradedStorageUsedPct
    ) {
      reasons.push(
        'HIGH_STORAGE_USAGE',
      );
    }

    return {
      state:
        reasons.length > 0
          ? 'DEGRADED'
          : 'ONLINE',
      reasons,
      lastHeartbeatAt,
      ageSeconds,
      offlineAfterSeconds,
    };
  }

  private healthyStatuses():
  Set<string> {
    return new Set([
      'online',
      'ok',
      'healthy',
      'active',
      'running',
    ]);
  }

  private degradedStatuses():
  Set<string> {
    return new Set([
      'offline',
      'warning',
      'maintenance',
      'error',
    ]);
  }

  private positiveNumber(
    value: string | undefined,
    fallback: number,
  ): number {
    const parsed = Number(value);

    return Number.isFinite(parsed) &&
      parsed > 0
      ? parsed
      : fallback;
  }
}
