import { Injectable } from '@nestjs/common';
import { DeviceService } from '../../device/services/device.service.js';
import { DeviceAvailabilityService } from '../../device/services/device-availability.service.js';
import type { DeviceAvailabilityQueryDto } from '../../device/dto/device-availability-query.dto.js';
import { SiteService } from '../../site/services/site.service.js';
import {
  aggregateAvailability,
  currentCounts,
  deviceRows,
  outageSummary,
  reliabilityLimitations,
  tallyExclusions,
} from '../domain/reliability-aggregation.js';
import type { SiteReliability } from '../domain/site-fleet-reliability.types.js';
import { ReliabilityPopulationService } from './reliability-population.service.js';

/**
 * Site & Fleet Reliability V1 — site scope. Strictly read-only: it only reads
 * the site row, the site's devices, Health Engine V2 current state and the
 * connectivity-event history. It never writes telemetry, events, alerts,
 * incidents or any aggregate row.
 */
@Injectable()
export class SiteReliabilityService {
  constructor(
    private readonly siteService: SiteService,
    private readonly deviceService: DeviceService,
    private readonly availabilityService: DeviceAvailabilityService,
    private readonly population: ReliabilityPopulationService,
  ) {}

  async getSiteReliability(
    organizationId: string,
    siteId: string,
    query: DeviceAvailabilityQueryDto,
  ): Promise<SiteReliability> {
    // Tenant isolation: a site outside the caller's organization is
    // indistinguishable from one that does not exist (SiteService.findOne
    // throws NotFoundException('Site not found')).
    const site = await this.siteService.findOne(organizationId, siteId);

    const now = new Date();
    const period = this.availabilityService.resolveAvailabilityPeriod(
      query,
      now,
    );

    const devices = (
      await this.deviceService.findAllReliabilityEligibleDevicesWithSite(
        organizationId,
      )
    ).filter((device) => device.siteId === siteId);

    // All non-deleted devices in the site, for excluded-population accounting.
    const allDevices = (
      await this.deviceService.findAll(organizationId)
    ).filter((device) => device.siteId === siteId);

    const eligibleIds = new Set(devices.map((device) => device.id));
    const excluded = allDevices.filter((device) => !eligibleIds.has(device.id));

    const inputs = await this.population.reconstructPopulation(
      devices,
      period,
      now,
    );

    const aggregate = aggregateAvailability(inputs, period.durationSeconds);

    return {
      generatedAt: now.toISOString(),
      site: {
        id: site.id,
        code: site.code,
        name: site.name,
        timezone: site.timezone,
        status: site.status,
      },
      period: {
        requestedFrom: period.requestedFrom,
        requestedTo: period.requestedTo,
        from: new Date(period.fromMs).toISOString(),
        to: new Date(period.toMs).toISOString(),
        durationSeconds: period.durationSeconds,
        window: period.window,
        clampedToNow: period.clampedToNow,
      },
      population: {
        eligibleDevices: inputs.length,
        excludedDevices: excluded.length,
        excludedByReason: tallyExclusions(excluded),
      },
      current: currentCounts(inputs),
      aggregateAvailability: aggregate,
      outages: outageSummary(inputs),
      devices: deviceRows(inputs),
      limitations: reliabilityLimitations('site', aggregate, inputs.length),
    };
  }
}
