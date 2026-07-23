import { Module } from '@nestjs/common';
import { DeviceController } from './controllers/device.controller';
import { DeviceRepository } from './repositories/device.repository';
import { DeviceConnectivityEventsService } from './services/device-connectivity-events.service';
import { DeviceTelemetryService } from './services/device-telemetry.service';
import { DeviceService } from './services/device.service';

@Module({
  controllers: [DeviceController],
  providers: [
    DeviceService,
    DeviceTelemetryService,
    DeviceConnectivityEventsService,
    DeviceRepository,
  ],
  exports: [
    DeviceService,
    DeviceTelemetryService,
    DeviceConnectivityEventsService,
  ],
})
export class DeviceModule {}
