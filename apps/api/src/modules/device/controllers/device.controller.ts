import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { CreateDeviceDto } from '../dto/create-device.dto';
import { DeviceAvailabilityQueryDto } from '../dto/device-availability-query.dto.js';
import { DeviceEvidenceQueryDto } from '../dto/device-evidence-query.dto.js';
import { SetDemoTelemetryStateDto } from '../dto/set-demo-telemetry-state.dto';
import { UpdateDeviceDto } from '../dto/update-device.dto';
import { DeviceAvailabilityService } from '../services/device-availability.service.js';
import { DeviceConnectivityEventsService } from '../services/device-connectivity-events.service';
import { DeviceIntelligenceService } from '../services/device-intelligence.service.js';
import { DeviceEvidenceService } from '../services/device-evidence.service.js';
import { DeviceTelemetryService } from '../services/device-telemetry.service';
import { DeviceTelemetryIngestionService } from '../services/device-telemetry-ingestion.service.js';
import { TelemetryDemoService } from '../services/telemetry-demo.service';
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
    private readonly telemetryDemoService: TelemetryDemoService,
    private readonly telemetryIngestionService: DeviceTelemetryIngestionService,
    private readonly deviceIntelligenceService: DeviceIntelligenceService,
    private readonly deviceAvailabilityService: DeviceAvailabilityService,
    private readonly deviceEvidenceService: DeviceEvidenceService,
  ) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.deviceService.findAll(user.organizationId);
  }

  @Get(':id/ingestion-key')
  getIngestionKeyStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.telemetryIngestionService.getKeyStatus(user.organizationId, id);
  }

  @Roles('ADMIN', 'OPERATOR')
  @Post(':id/ingestion-key/rotate')
  rotateIngestionKey(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.telemetryIngestionService.rotateKey(user.organizationId, id);
  }

  @Get('demo/status')
  getDemoStatus() {
    return this.telemetryDemoService.getStatus();
  }

  @Roles('ADMIN', 'OPERATOR')
  @Post(':id/demo-state')
  async setDemoState(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: SetDemoTelemetryStateDto,
  ) {
    await this.telemetryDemoService.setState(
      user.organizationId,
      id,
      data.state,
    );

    return this.deviceTelemetryService.findByDeviceId(id, user.organizationId);
  }

  @Roles('ADMIN', 'OPERATOR')
  @Delete(':id/demo-state')
  async clearDemoState(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.telemetryDemoService.clearState(user.organizationId, id);

    return this.deviceTelemetryService.findByDeviceId(id, user.organizationId);
  }

  @Get('telemetry')
  findFleetTelemetry(@CurrentUser() user: AuthUser) {
    return this.deviceTelemetryService.findFleet(user.organizationId);
  }

  @Roles('ADMIN', 'OPERATOR')
  @Post('telemetry/evaluate')
  evaluateConnectivity(@CurrentUser() user: AuthUser) {
    return this.connectivityEventsService.evaluateFleet(user.organizationId);
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
    return this.deviceTelemetryService.findByDeviceId(id, user.organizationId);
  }

  @Get(':id/intelligence')
  findIntelligence(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deviceIntelligenceService.getIntelligence(
      id,
      user.organizationId,
    );
  }

  @Get(':id/evidence')
  findEvidence(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DeviceEvidenceQueryDto,
  ) {
    return this.deviceEvidenceService.findByDeviceId(
      id,
      user.organizationId,
      query.limit,
    );
  }

  @Get(':id/stream-measurement')
  findStreamMeasurement(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deviceEvidenceService.latestStreamMeasurement(
      id,
      user.organizationId,
    );
  }

  @Get(':id/availability')
  findAvailability(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DeviceAvailabilityQueryDto,
  ) {
    return this.deviceAvailabilityService.getAvailability(
      id,
      user.organizationId,
      query,
    );
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deviceService.findOne(user.organizationId, id);
  }

  @Roles('ADMIN', 'OPERATOR')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() data: CreateDeviceDto) {
    return this.deviceService.create(user.organizationId, data);
  }

  @Roles('ADMIN', 'OPERATOR')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: UpdateDeviceDto,
  ) {
    return this.deviceService.update(user.organizationId, id, data);
  }

  @Roles('ADMIN', 'OPERATOR')
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deviceService.remove(user.organizationId, id);
  }
}
