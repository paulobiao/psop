import { Module } from '@nestjs/common';
import { DeviceController } from './controllers/device.controller';
import { DeviceRepository } from './repositories/device.repository';
import { DeviceService } from './services/device.service';
import { DeviceTelemetryService } from './services/device-telemetry.service';

@Module({
  controllers: [DeviceController],
  providers: [DeviceService, DeviceTelemetryService, DeviceRepository],
  exports: [DeviceService, DeviceTelemetryService],
})
export class DeviceModule {}
