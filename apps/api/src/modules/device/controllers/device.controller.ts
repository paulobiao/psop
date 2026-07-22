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

@Controller({
  path: 'devices',
  version: '1',
})
export class DeviceController {
  constructor(private readonly deviceService: DeviceService) {}

  @Get()
  findAll() {
    return this.deviceService.findAll();
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
