import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TELEMETRY_DEMO_STATES,
  type TelemetryDemoState,
} from '../dto/set-demo-telemetry-state.dto';
import {
  DeviceRepository,
  type DeviceWithSite,
} from '../repositories/device.repository';

type TelemetryItem = Record<string, unknown>;

@Injectable()
export class TelemetryDemoService {
  private readonly enabled: boolean;
  private readonly states =
    new Map<string, TelemetryDemoState>();

  constructor(
    configService: ConfigService,
    private readonly deviceRepository:
      DeviceRepository,
  ) {
    const rawValue =
      configService.get<string>(
        'TELEMETRY_DEMO_MODE',
      ) ?? 'false';

    this.enabled = [
      'true',
      '1',
      'yes',
      'on',
    ].includes(rawValue.toLowerCase());
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      states: [
        ...TELEMETRY_DEMO_STATES,
      ],
      activeOverrides:
        this.states.size,
    };
  }

  async setState(
    organizationId: string,
    deviceId: string,
    state: TelemetryDemoState,
  ) {
    this.assertEnabled();

    const device =
      await this.findCamera(
        organizationId,
        deviceId,
      );

    if (state === 'NEVER_SEEN') {
      this.states.delete(device.id);
    } else {
      this.states.set(
        device.id,
        state,
      );
    }

    return {
      deviceId: device.id,
      externalId:
        device.externalId,
      state,
      updatedAt:
        new Date().toISOString(),
    };
  }

  async clearState(
    organizationId: string,
    deviceId: string,
  ) {
    this.assertEnabled();

    const device =
      await this.findCamera(
        organizationId,
        deviceId,
      );

    this.states.delete(device.id);

    return {
      deviceId: device.id,
      externalId:
        device.externalId,
      state:
        'NEVER_SEEN' as const,
      updatedAt:
        new Date().toISOString(),
    };
  }

  getItem(
    device: DeviceWithSite,
  ): TelemetryItem | undefined {
    if (!this.enabled) {
      return undefined;
    }

    const state =
      this.states.get(device.id);

    if (
      !state ||
      state === 'NEVER_SEEN'
    ) {
      return undefined;
    }

    const nowSeconds =
      Math.floor(Date.now() / 1000);

    const base = {
      camera_id: device.id,
      site_id: device.siteId,
      external_id:
        device.externalId,
      model:
        device.model ??
        'PSOP Demo Camera',
      firmware:
        device.firmwareVersion ??
        'demo-1.0.0',
      bitrate_kbps: 4200,
      uptime_seconds: 86400,
      iso_time:
        new Date().toISOString(),
    };

    if (state === 'UNKNOWN') {
      return {
        ...base,
        status: 'unknown',
        timestamp: nowSeconds,
        temperature_c: 45,
        storage_used_pct: 50,
      };
    }

    if (state === 'OFFLINE') {
      return {
        ...base,
        status: 'offline',
        timestamp:
          nowSeconds -
          Math.max(
            3600,
            device
              .expectedHeartbeatInterval *
              10,
          ),
        temperature_c: 44,
        storage_used_pct: 55,
      };
    }

    if (state === 'DEGRADED') {
      return {
        ...base,
        status: 'warning',
        timestamp: nowSeconds,
        temperature_c: 82,
        storage_used_pct: 96,
      };
    }

    return {
      ...base,
      status: 'online',
      timestamp: nowSeconds,
      temperature_c: 44,
      storage_used_pct: 52,
    };
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        'Telemetry demo mode is disabled',
      );
    }
  }

  private async findCamera(
    organizationId: string,
    deviceId: string,
  ): Promise<DeviceWithSite> {
    const device =
      await this.deviceRepository
        .findByIdWithSite(
          deviceId,
          organizationId,
        );

    if (!device) {
      throw new NotFoundException(
        'Device not found',
      );
    }

    if (
      device.deviceType !== 'CAMERA'
    ) {
      throw new BadRequestException(
        'Telemetry demo is available only for camera devices',
      );
    }

    return device;
  }
}
