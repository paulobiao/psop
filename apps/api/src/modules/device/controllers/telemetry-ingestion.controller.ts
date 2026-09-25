import { IngestStreamEvidenceDto } from '../dto/ingest-stream-evidence.dto.js';
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
  IngestRecorderObservationsDto,
} from '../dto/ingest-recorder-observations.dto.js';
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

  @Public()
  @Post('stream-evidence')
  ingestStreamEvidence(
    @Headers('x-device-id') observerDeviceId: string | undefined,
    @Headers('x-device-key') deviceKey: string | undefined,
    @Body() input: IngestStreamEvidenceDto,
  ) {
    if (!observerDeviceId || !isUUID(observerDeviceId) || !deviceKey) {
      throw new UnauthorizedException('Device credentials required');
    }
    return this.ingestion.ingestStreamEvidence(observerDeviceId, deviceKey, input);
  }

  @Public()
  @Post('recorder-observations')
  ingestRecorderObservations(
    @Headers('x-device-id')
    recorderDeviceId: string | undefined,
    @Headers('x-device-key')
    deviceKey: string | undefined,
    @Body()
    input: IngestRecorderObservationsDto,
  ) {
    if (
      !recorderDeviceId ||
      !isUUID(recorderDeviceId) ||
      !deviceKey
    ) {
      throw new UnauthorizedException(
        'Recorder credentials required',
      );
    }

    return this.ingestion.ingestRecorderObservations(
      recorderDeviceId,
      deviceKey,
      input,
    );
  }

}
