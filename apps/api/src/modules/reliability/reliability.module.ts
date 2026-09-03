import { Module } from '@nestjs/common';
import { DeviceModule } from '../device/device.module.js';
import { SiteModule } from '../site/site.module.js';
import { FleetReliabilityController } from './controllers/fleet-reliability.controller.js';
import { SiteReliabilityController } from './controllers/site-reliability.controller.js';
import { FleetReliabilityService } from './services/fleet-reliability.service.js';
import { ReliabilityPopulationService } from './services/reliability-population.service.js';
import { SiteReliabilityService } from './services/site-reliability.service.js';

/**
 * PSOP Site & Fleet Reliability V1.
 *
 * Additive, read-only. Reuses `DeviceAvailabilityService` (Availability V1
 * pipeline + Health Engine V2 current state) and the site / device
 * repositories; adds no schema, no migration, no write path.
 */
@Module({
  imports: [DeviceModule, SiteModule],
  controllers: [SiteReliabilityController, FleetReliabilityController],
  providers: [
    ReliabilityPopulationService,
    SiteReliabilityService,
    FleetReliabilityService,
  ],
})
export class ReliabilityModule {}
