import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import {
  Public,
} from '../../auth/decorators/public.decorator.js';
import {
  IngestDeviceTelemetryDto,
} from '../dto/ingest-device-telemetry.dto.js';
import {
  DeviceTelemetryIngestionService,
} from '../services/device-telemetry-ingestion.service.js';

@Controller({
  path: 'telemetry',
  version: '1',
})
export class TelemetryIngestionController {
  constructor(
    private readonly ingestion:
      DeviceTelemetryIngestionService,
  ) {}

  @Public()
  @Post('ingest')
  ingestTelemetry(
    @Headers('x-device-id')
    deviceId: string | undefined,
    @Headers('x-device-key')
    deviceKey: string | undefined,
    @Body()
    input: IngestDeviceTelemetryDto,
  ) {
    if (!deviceId || !isUUID(deviceId) || !deviceKey) {
      throw new UnauthorizedException(
        'Device credentials required',
      );
    }

    return this.ingestion.ingest(
      deviceId,
      deviceKey,
      input,
    );
  }
}
