import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { AlertService } from '../services/alert.service.js';

@Controller({
  path: 'alerts',
  version: '1',
})
export class AlertController {
  constructor(private readonly alertService: AlertService) {}

  @Get('active')
  findActive(@Query('deviceId') deviceId?: string) {
    return this.alertService.findActive(deviceId);
  }

  @Get()
  findAll(
    @Query('status') status?: string,
    @Query('deviceId') deviceId?: string,
  ) {
    return this.alertService.findAll(status, deviceId);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.alertService.findOne(id);
  }

  @Patch(':id/resolve')
  resolve(@Param('id', ParseUUIDPipe) id: string) {
    return this.alertService.resolve(id);
  }
}
