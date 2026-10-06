import { Module } from '@nestjs/common';
import { AlertModule } from '../alert/alert.module.js';
import { DeviceController } from './controllers/device.controller.js';
import { TelemetryIngestionController } from './controllers/telemetry-ingestion.controller.js';
import { DeviceRepository } from './repositories/device.repository.js';
import { DeviceAvailabilityService } from './services/device-availability.service.js';
import { DeviceConnectivityEventsService } from './services/device-connectivity-events.service.js';
import { DeviceConnectivityMonitorService } from './services/device-connectivity-monitor.service.js';
import { EdgeAgentRuntimeService } from './services/edge-agent-runtime.service.js';
import { DeviceHealthService } from './services/device-health.service.js';
import { DeviceEvidenceService } from './services/device-evidence.service.js';
import { DeviceIntelligenceService } from './services/device-intelligence.service.js';
import { DeviceTelemetryIngestionService } from './services/device-telemetry-ingestion.service.js';
import { DeviceTelemetryService } from './services/device-telemetry.service.js';
import { DeviceService } from './services/device.service.js';
import { LocalTelemetryService } from './services/local-telemetry.service.js';
import { RecorderObservationService } from './services/recorder-observation.service.js';
import { TelemetryDemoService } from './services/telemetry-demo.service.js';

@Module({
  imports: [AlertModule],
  controllers: [
    DeviceController,
    TelemetryIngestionController,
  ],
  providers: [
    DeviceService,
    DeviceTelemetryService,
    DeviceAvailabilityService,
    DeviceConnectivityEventsService,
    DeviceConnectivityMonitorService,
    DeviceHealthService,
    DeviceEvidenceService,
    DeviceIntelligenceService,
    EdgeAgentRuntimeService,
    TelemetryDemoService,
    LocalTelemetryService,
    RecorderObservationService,
    DeviceTelemetryIngestionService,
    DeviceRepository,
  ],
  exports: [
    DeviceService,
    DeviceTelemetryService,
    DeviceIntelligenceService,
    DeviceAvailabilityService,
    DeviceConnectivityEventsService,
    EdgeAgentRuntimeService,
    TelemetryDemoService,
    LocalTelemetryService,
    RecorderObservationService,
  ],
})
export class DeviceModule {}
