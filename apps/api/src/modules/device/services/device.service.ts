import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Device } from '../../../../generated/prisma/client.js';
import { AlertService } from '../../alert/services/alert.service.js';
import { CreateDeviceDto } from '../dto/create-device.dto';
import { UpdateDeviceDto } from '../dto/update-device.dto';
import {
  DeviceRepository,
  type DeviceWithSite,
} from '../repositories/device.repository';

type MonitoringMode =
  | 'DIRECT'
  | 'VIA_GATEWAY'
  | 'INVENTORY_ONLY';

@Injectable()
export class DeviceService {
  constructor(
    private readonly deviceRepository: DeviceRepository,
    private readonly alertService: AlertService,
  ) {}

  async findAll(
    organizationId: string,
  ): Promise<Device[]> {
    return this.deviceRepository.findAll(organizationId);
  }

  /**
   * Devices eligible for Site & Fleet Reliability aggregation: the
   * individually-observable devices (same predicate used everywhere else)
   * restricted to `status === ACTIVE`. See
   * `DeviceRepository.findAllReliabilityEligibleDevicesWithSite`.
   */
  async findAllReliabilityEligibleDevicesWithSite(
    organizationId: string,
  ): Promise<DeviceWithSite[]> {
    return this.deviceRepository.findAllReliabilityEligibleDevicesWithSite(
      organizationId,
    );
  }

  async findOne(
    organizationId: string,
    id: string,
  ): Promise<Device> {
    const device = await this.deviceRepository.findById(
      id,
      organizationId,
    );

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    return device;
  }

  async create(
    organizationId: string,
    data: CreateDeviceDto,
  ): Promise<Device> {
    await this.validateSite(
      data.siteId,
      organizationId,
    );

    const monitoring = await this.validateMonitoring({
      organizationId,
      siteId: data.siteId,
      deviceId: null,
      monitoringMode: data.monitoringMode ?? 'DIRECT',
      gatewayDeviceId: data.gatewayDeviceId ?? null,
    });

    return this.deviceRepository.create({
      ...data,
      ...monitoring,
    });
  }

  async update(
    organizationId: string,
    id: string,
    data: UpdateDeviceDto,
  ): Promise<Device> {
    const current = await this.findOne(
      organizationId,
      id,
    );

    const siteId = data.siteId ?? current.siteId;

    if (data.siteId) {
      await this.validateSite(
        data.siteId,
        organizationId,
      );
    }

    const managedDevices =
      await this.deviceRepository.countManagedDevices(id);

    if (
      managedDevices > 0 &&
      (
        (data.siteId && data.siteId !== current.siteId) ||
        (
          data.deviceType &&
          !['GATEWAY', 'RECORDER'].includes(data.deviceType)
        ) ||
        (
          data.monitoringMode &&
          data.monitoringMode !== 'DIRECT'
        )
      )
    ) {
      throw new BadRequestException(
        'A gateway with assigned devices must remain a directly monitored gateway or recorder in the same site',
      );
    }

    const monitoring = await this.validateMonitoring({
      organizationId,
      siteId,
      deviceId: id,
      monitoringMode:
        data.monitoringMode ??
        current.monitoringMode,
      gatewayDeviceId:
        data.gatewayDeviceId === undefined
          ? current.gatewayDeviceId
          : data.gatewayDeviceId,
    });

    const updated =
      await this.deviceRepository.update(id, {
        ...data,
        ...monitoring,
      });

    const supportsDirectTelemetry =
      updated.monitoringMode === 'DIRECT' &&
      [
        'CAMERA',
        'RECORDER',
        'GATEWAY',
      ].includes(updated.deviceType);

    if (!supportsDirectTelemetry) {
      await this.alertService.resolveConnectivityAlert(
        updated.id,
        'NOT_DIRECTLY_MONITORED',
      );
    }

    return updated;
  }

  async remove(
    organizationId: string,
    id: string,
  ): Promise<Device> {
    await this.findOne(organizationId, id);

    const managedDevices =
      await this.deviceRepository.countManagedDevices(id);

    if (managedDevices > 0) {
      throw new BadRequestException(
        'Remove or reassign devices connected to this gateway first',
      );
    }

    return this.deviceRepository.softDelete(id);
  }

  private async validateMonitoring(input: {
    organizationId: string;
    siteId: string;
    deviceId: string | null;
    monitoringMode: MonitoringMode;
    gatewayDeviceId: string | null;
  }): Promise<{
    monitoringMode: MonitoringMode;
    gatewayDeviceId: string | null;
  }> {
    if (input.monitoringMode !== 'VIA_GATEWAY') {
      return {
        monitoringMode: input.monitoringMode,
        gatewayDeviceId: null,
      };
    }

    if (!input.gatewayDeviceId) {
      throw new BadRequestException(
        'A gateway device is required for VIA_GATEWAY monitoring',
      );
    }

    if (input.gatewayDeviceId === input.deviceId) {
      throw new BadRequestException(
        'A device cannot monitor itself',
      );
    }

    const gateway = await this.deviceRepository.findById(
      input.gatewayDeviceId,
      input.organizationId,
    );

    if (!gateway) {
      throw new NotFoundException(
        'Gateway device not found',
      );
    }

    if (
      !['GATEWAY', 'RECORDER'].includes(
        gateway.deviceType,
      )
    ) {
      throw new BadRequestException(
        'The selected monitoring device must be a gateway or recorder',
      );
    }

    if (gateway.siteId !== input.siteId) {
      throw new BadRequestException(
        'The selected gateway must belong to the same site',
      );
    }

    if (gateway.monitoringMode !== 'DIRECT') {
      throw new BadRequestException(
        'The selected gateway must use direct monitoring',
      );
    }

    return {
      monitoringMode: 'VIA_GATEWAY',
      gatewayDeviceId: gateway.id,
    };
  }

  private async validateSite(
    siteId: string,
    organizationId: string,
  ): Promise<void> {
    const valid =
      await this.deviceRepository.siteBelongsToOrganization(
        siteId,
        organizationId,
      );

    if (!valid) {
      throw new NotFoundException('Site not found');
    }
  }
}
