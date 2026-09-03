import { Injectable } from '@nestjs/common';
import { DeviceService } from '../../device/services/device.service.js';
import { DeviceAvailabilityService } from '../../device/services/device-availability.service.js';
import type { DeviceAvailabilityQueryDto } from '../../device/dto/device-availability-query.dto.js';
import { SiteService } from '../../site/services/site.service.js';
import {
  aggregateAvailability,
  currentCounts,
  outageSummary,
  reliabilityLimitations,
  tallyExclusions,
} from '../domain/reliability-aggregation.js';
import type { DeviceReliabilityInput } from '../domain/reliability-aggregation.js';
import type {
  FleetReliability,
  FleetSiteRow,
} from '../domain/site-fleet-reliability.types.js';
import { ReliabilityPopulationService } from './reliability-population.service.js';

/**
 * Site & Fleet Reliability V1 — organization scope. Strictly read-only.
 *
 * The organization figure is recomputed from the TOTAL device-seconds of every
 * eligible device in every site — never as a mean of the per-site percentages,
 * so a 1-device site does not weigh the same as a 100-device site.
 */
@Injectable()
export class FleetReliabilityService {
  constructor(
    private readonly siteService: SiteService,
    private readonly deviceService: DeviceService,
    private readonly availabilityService: DeviceAvailabilityService,
    private readonly population: ReliabilityPopulationService,
  ) {}

  async getFleetReliability(
    organizationId: string,
    query: DeviceAvailabilityQueryDto,
  ): Promise<FleetReliability> {
    const now = new Date();
    const period = this.availabilityService.resolveAvailabilityPeriod(
      query,
      now,
    );

    const [sites, eligibleDevices, allDevices] = await Promise.all([
      this.siteService.findAll(organizationId),
      this.deviceService.findAllReliabilityEligibleDevicesWithSite(
        organizationId,
      ),
      this.deviceService.findAll(organizationId),
    ]);

    const eligibleIds = new Set(eligibleDevices.map((device) => device.id));
    const excluded = allDevices.filter((device) => !eligibleIds.has(device.id));

    const inputs = await this.population.reconstructPopulation(
      eligibleDevices,
      period,
      now,
    );

    const inputsBySite = new Map<string, DeviceReliabilityInput[]>();
    for (const input of inputs) {
      const bucket = inputsBySite.get(input.siteId) ?? [];
      bucket.push(input);
      inputsBySite.set(input.siteId, bucket);
    }

    const siteRows: FleetSiteRow[] = sites
      .map((site) => {
        const siteInputs = inputsBySite.get(site.id) ?? [];
        const siteAggregate = aggregateAvailability(
          siteInputs,
          period.durationSeconds,
        );
        const siteCurrent = currentCounts(siteInputs);
        const siteOutages = outageSummary(siteInputs);

        return {
          siteId: site.id,
          siteName: site.name,
          code: site.code,
          eligibleDevices: siteInputs.length,
          currentOffline: siteCurrent.offline,
          availabilityPercentage: siteAggregate.percentage,
          confirmedAvailabilityPercentage:
            siteAggregate.confirmedAvailabilityPercentage,
          coveragePercentage: siteAggregate.coveragePercentage,
          uptimeDeviceSeconds: siteAggregate.uptimeDeviceSeconds,
          downtimeDeviceSeconds: siteAggregate.downtimeDeviceSeconds,
          outageCount: siteOutages.total,
          unavailableReason: siteAggregate.unavailableReason,
        };
      })
      .sort(
        (first, second) =>
          second.downtimeDeviceSeconds - first.downtimeDeviceSeconds ||
          first.siteName.localeCompare(second.siteName),
      );

    // Organization aggregate: from the full device-seconds pool, NOT a mean of
    // siteRows[].availabilityPercentage.
    const aggregate = aggregateAvailability(inputs, period.durationSeconds);

    return {
      generatedAt: now.toISOString(),
      organizationId,
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
        sites: sites.length,
        sitesWithEligibleDevices: inputsBySite.size,
        eligibleDevices: inputs.length,
        excludedDevices: excluded.length,
        excludedByReason: tallyExclusions(excluded),
      },
      current: currentCounts(inputs),
      aggregateAvailability: aggregate,
      outages: outageSummary(inputs),
      sites: siteRows,
      limitations: reliabilityLimitations('fleet', aggregate, inputs.length),
    };
  }
}
