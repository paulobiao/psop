import { Injectable } from '@nestjs/common';
import {
  DeviceAvailabilityService,
  type ResolvedPeriod,
} from '../../device/services/device-availability.service.js';
import type { DeviceWithSite } from '../../device/repositories/device.repository.js';
import type { DeviceReliabilityInput } from '../domain/reliability-aggregation.js';

/** Max per-device reconstructions in flight at once. Correctness first (V1). */
const RECONSTRUCTION_CONCURRENCY = 8;

/**
 * Turns each reliability-eligible device into a `DeviceReliabilityInput` by
 * running the shared Availability V1 reconstruction, with bounded concurrency.
 * Read-only. Shared by Site and Fleet reliability so both use exactly one
 * reconstruction path.
 */
@Injectable()
export class ReliabilityPopulationService {
  constructor(
    private readonly availabilityService: DeviceAvailabilityService,
  ) {}

  async reconstructPopulation(
    eligible: DeviceWithSite[],
    period: ResolvedPeriod,
    now: Date,
  ): Promise<DeviceReliabilityInput[]> {
    const results = new Array<DeviceReliabilityInput>(eligible.length);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < eligible.length) {
        const index = cursor;
        cursor += 1;
        const device = eligible[index];

        const reconstruction =
          await this.availabilityService.reconstructForResolvedDevice(
            device,
            period,
            now,
          );

        results[index] = {
          deviceId: device.id,
          name: device.name,
          deviceType: device.deviceType,
          monitoringMode: device.monitoringMode,
          siteId: device.siteId,
          currentLinkState: reconstruction.currentLinkState,
          totals: reconstruction.totals,
          confirmedObservedSeconds: reconstruction.confirmedObservedSeconds,
          percentage: reconstruction.percentage,
          confirmedAvailabilityPercentage:
            reconstruction.confirmedAvailabilityPercentage,
          coveragePercentage: reconstruction.coveragePercentage,
          intervals: reconstruction.intervals,
          longest: reconstruction.longest,
          lastOutageAt: reconstruction.lastOutageAt,
          lastRecoveryAt: reconstruction.lastRecoveryAt,
        };
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(RECONSTRUCTION_CONCURRENCY, eligible.length) },
        worker,
      ),
    );

    return results;
  }
}
