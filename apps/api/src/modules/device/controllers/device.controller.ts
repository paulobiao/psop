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
import type { AuthUser } from '../../auth/auth.types.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { CreateDeviceDto } from '../dto/create-device.dto';
import { UpdateDeviceDto } from '../dto/update-device.dto';
import { DeviceConnectivityEventsService } from '../services/device-connectivity-events.service';
import { DeviceTelemetryService } from '../services/device-telemetry.service';
import { DeviceService } from '../services/device.service';

@Controller({
  path: 'devices',
  version: '1',
})
export class DeviceController {
  constructor(
    private readonly deviceService: DeviceService,
    private readonly deviceTelemetryService: DeviceTelemetryService,
    private readonly connectivityEventsService: DeviceConnectivityEventsService,
  ) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.deviceService.findAll(user.organizationId);
  }

  @Get('telemetry')
  findFleetTelemetry(@CurrentUser() user: AuthUser) {
    return this.deviceTelemetryService.findFleet(
      user.organizationId,
    );
  }

  @Roles('ADMIN', 'OPERATOR')
  @Post('telemetry/evaluate')
  evaluateConnectivity(@CurrentUser() user: AuthUser) {
    return this.connectivityEventsService.evaluateFleet(
      user.organizationId,
    );
  }

  @Get(':id/connectivity-events')
  findConnectivityEvents(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.connectivityEventsService.findByDeviceId(
      id,
      user.organizationId,
    );
  }

  @Get(':id/telemetry')
  findTelemetry(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deviceTelemetryService.findByDeviceId(
      id,
      user.organizationId,
    );
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deviceService.findOne(
      user.organizationId,
      id,
    );
  }

  @Roles('ADMIN', 'OPERATOR')
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() data: CreateDeviceDto,
  ) {
    return this.deviceService.create(
      user.organizationId,
      data,
    );
  }

  @Roles('ADMIN', 'OPERATOR')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: UpdateDeviceDto,
  ) {
    return this.deviceService.update(
      user.organizationId,
      id,
      data,
    );
  }

  @Roles('ADMIN', 'OPERATOR')
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deviceService.remove(
      user.organizationId,
      id,
    );
  }
}
