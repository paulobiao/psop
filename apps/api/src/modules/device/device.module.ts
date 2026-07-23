import { Module } from '@nestjs/common';
import { AlertModule } from '../alert/alert.module.js';
import { DeviceController } from './controllers/device.controller.js';
import { DeviceRepository } from './repositories/device.repository.js';
import { DeviceConnectivityEventsService } from './services/device-connectivity-events.service.js';
import { DeviceConnectivityMonitorService } from './services/device-connectivity-monitor.service.js';
import { DeviceTelemetryService } from './services/device-telemetry.service.js';
import { DeviceService } from './services/device.service.js';

@Module({
  imports: [AlertModule],
  controllers: [DeviceController],
  providers: [
    DeviceService,
    DeviceTelemetryService,
    DeviceConnectivityEventsService,
    DeviceConnectivityMonitorService,
    DeviceRepository,
  ],
  exports: [
    DeviceService,
    DeviceTelemetryService,
    DeviceConnectivityEventsService,
  ],
})
export class DeviceModule {}
