import { Injectable, NotFoundException } from '@nestjs/common';
import type { Device } from '../../../../generated/prisma/client.js';
import { CreateDeviceDto } from '../dto/create-device.dto';
import { UpdateDeviceDto } from '../dto/update-device.dto';
import { DeviceRepository } from '../repositories/device.repository';

@Injectable()
export class DeviceService {
  constructor(private readonly deviceRepository: DeviceRepository) {}

  async findAll(): Promise<Device[]> {
    return this.deviceRepository.findAll();
  }

  async findOne(id: string): Promise<Device> {
    const device = await this.deviceRepository.findById(id);

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    return device;
  }

  async create(data: CreateDeviceDto): Promise<Device> {
    return this.deviceRepository.create(data);
  }

  async update(id: string, data: UpdateDeviceDto): Promise<Device> {
    await this.findOne(id);
    return this.deviceRepository.update(id, data);
  }

  async remove(id: string): Promise<Device> {
    await this.findOne(id);
    return this.deviceRepository.softDelete(id);
  }
}
