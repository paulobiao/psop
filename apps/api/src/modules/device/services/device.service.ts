import { Injectable, NotFoundException } from '@nestjs/common';
import type { Device } from '../../../../generated/prisma/client.js';
import { CreateDeviceDto } from '../dto/create-device.dto';
import { UpdateDeviceDto } from '../dto/update-device.dto';
import { DeviceRepository } from '../repositories/device.repository';

@Injectable()
export class DeviceService {
  constructor(
    private readonly deviceRepository: DeviceRepository,
  ) {}

  async findAll(
    organizationId: string,
  ): Promise<Device[]> {
    return this.deviceRepository.findAll(organizationId);
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

    return this.deviceRepository.create(data);
  }

  async update(
    organizationId: string,
    id: string,
    data: UpdateDeviceDto,
  ): Promise<Device> {
    await this.findOne(organizationId, id);

    if (data.siteId) {
      await this.validateSite(
        data.siteId,
        organizationId,
      );
    }

    return this.deviceRepository.update(id, data);
  }

  async remove(
    organizationId: string,
    id: string,
  ): Promise<Device> {
    await this.findOne(organizationId, id);

    return this.deviceRepository.softDelete(id);
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
