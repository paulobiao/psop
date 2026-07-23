import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateDeviceDto } from '../dto/create-device.dto';
import { UpdateDeviceDto } from '../dto/update-device.dto';
import { DeviceService } from '../services/device.service';
import { DeviceTelemetryService } from '../services/device-telemetry.service';

@Controller({
  path: 'devices',
  version: '1',
})
export class DeviceController {
  constructor(
    private readonly deviceService: DeviceService,
    private readonly deviceTelemetryService: DeviceTelemetryService,
  ) {}

  @Get()
  findAll() {
    return this.deviceService.findAll();
  }

  @Get(':id/telemetry')
  findTelemetry(@Param('id', ParseUUIDPipe) id: string) {
    return this.deviceTelemetryService.findByDeviceId(id);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.deviceService.findOne(id);
  }

  @Post()
  create(@Body() data: CreateDeviceDto) {
    return this.deviceService.create(data);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: UpdateDeviceDto,
  ) {
    return this.deviceService.update(id, data);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.deviceService.remove(id);
  }
}
