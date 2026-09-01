/**
 * Pure device-time aggregation for Site & Fleet Reliability V1.
 *
 * Every function here is deterministic and side-effect free. The per-device
 * inputs are Availability V1 figures produced by
 * `DeviceAvailabilityService.reconstructForResolvedDevice` — this module only
 * sums them; it never reconstructs availability or connectivity itself.
 */

import type {
  DeviceType,
  DeviceMonitoringMode,
  DeviceStatus,
} from '../../../../generated/prisma/client.js';
import type { AvailabilityOutageInterval } from '../../device/domain/operational-availability.types.js';
import type { LinkState } from '../../device/domain/operational-health.types.js';
import type {
  AggregateAvailability,
  AggregateUnavailableReason,
  ReliabilityCurrentCounts,
  ReliabilityDeviceRow,
  ReliabilityExclusionReason,
  ReliabilityOutageSummary,
} from './site-fleet-reliability.types.js';

/**
 * The slice of a per-device reconstruction the aggregation needs. Kept minimal
 * and structurally typed so the services can pass the real
 * `DeviceAvailabilityReconstruction` straight through.
 */
export interface DeviceReliabilityInput {
  deviceId: string;
  name: string;
  deviceType: string;
  monitoringMode: string;
  siteId: string;
  currentLinkState: LinkState | null;
  totals: {
    uptimeSeconds: number;
    downtimeSeconds: number;
    unknownSeconds: number;
    neverSeenSeconds: number;
    noDataSeconds: number;
  };
  confirmedObservedSeconds: number;
  percentage: number | null;
  confirmedAvailabilityPercentage: number | null;
  coveragePercentage: number;
  intervals: AvailabilityOutageInterval[];
  longest: AvailabilityOutageInterval | null;
  lastOutageAt: string | null;
  lastRecoveryAt: string | null;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** unknown + neverSeen + noData for one device. */
export function deviceUnknownSeconds(input: DeviceReliabilityInput): number {
  return (
    input.totals.unknownSeconds +
    input.totals.neverSeenSeconds +
    input.totals.noDataSeconds
  );
}

export function aggregateAvailability(
  devices: DeviceReliabilityInput[],
  periodDurationSeconds: number,
): AggregateAvailability {
  const eligibleDeviceCount = devices.length;
  const expectedDeviceSeconds = periodDurationSeconds * eligibleDeviceCount;

  let uptimeDeviceSeconds = 0;
  let downtimeDeviceSeconds = 0;
  let unknownDeviceSeconds = 0;

  for (const device of devices) {
    uptimeDeviceSeconds += device.totals.uptimeSeconds;
    downtimeDeviceSeconds += device.totals.downtimeSeconds;
    unknownDeviceSeconds += deviceUnknownSeconds(device);
  }

  const confirmedDeviceSeconds = uptimeDeviceSeconds + downtimeDeviceSeconds;

  const coveragePercentage =
    expectedDeviceSeconds > 0
      ? round4((confirmedDeviceSeconds / expectedDeviceSeconds) * 100)
      : null;

  const confirmedAvailabilityPercentage =
    confirmedDeviceSeconds > 0
      ? round4((uptimeDeviceSeconds / confirmedDeviceSeconds) * 100)
      : null;

  // A period-level figure is honest ONLY when the whole population is fully
  // observed for the whole period. The gate is `unknownDeviceSeconds === 0`
  // (UNKNOWN + NEVER_SEEN + NO_DATA): a fully-covered device contributes zero
  // such device-seconds. `confirmedDeviceSeconds` may still differ from
  // `expectedDeviceSeconds` by a few seconds because per-device Availability V1
  // rounds each segment to whole seconds — that slack is deliberately NOT used
  // as the gate, so sub-second rounding can never promote a real coverage gap
  // to a complete one, nor demote a genuinely-covered population.
  const unavailableReason: AggregateUnavailableReason | null =
    eligibleDeviceCount === 0
      ? 'NO_ELIGIBLE_DEVICES'
      : confirmedDeviceSeconds === 0
        ? 'NO_CONFIRMED_OBSERVATION'
        : unknownDeviceSeconds > 0
          ? 'INCOMPLETE_COVERAGE'
          : null;

  const percentage =
    unavailableReason === null ? confirmedAvailabilityPercentage : null;

  return {
    percentage,
    confirmedAvailabilityPercentage,
    coveragePercentage,
    uptimeDeviceSeconds,
    downtimeDeviceSeconds,
    unknownDeviceSeconds,
    expectedDeviceSeconds,
    confirmedDeviceSeconds,
    unavailableReason,
  };
}

export function currentCounts(
  devices: DeviceReliabilityInput[],
): ReliabilityCurrentCounts {
  const counts: ReliabilityCurrentCounts = {
    online: 0,
    offline: 0,
    unknown: 0,
    neverSeen: 0,
  };

  for (const device of devices) {
    switch (device.currentLinkState) {
      case 'ONLINE':
        counts.online += 1;
        break;
      case 'OFFLINE':
        counts.offline += 1;
        break;
      case 'NEVER_SEEN':
        counts.neverSeen += 1;
        break;
      default:
        // UNKNOWN, or a missing link verdict — never assumed online.
        counts.unknown += 1;
    }
  }

  return counts;
}

export function outageSummary(
  devices: DeviceReliabilityInput[],
): ReliabilityOutageSummary {
  let total = 0;
  let devicesAffected = 0;
  let totalDowntimeDeviceSeconds = 0;

  let longest: ReliabilityOutageSummary['longest'] = null;
  let lastOutageAt: string | null = null;
  let lastConfirmedRecoveryAt: string | null = null;

  for (const device of devices) {
    total += device.intervals.length;
    totalDowntimeDeviceSeconds += device.totals.downtimeSeconds;

    if (device.intervals.length > 0) {
      devicesAffected += 1;
    }

    if (
      device.longest &&
      (!longest || device.longest.durationSeconds > longest.durationSeconds)
    ) {
      longest = {
        deviceId: device.deviceId,
        deviceName: device.name,
        startedAt: device.longest.startedAt,
        endedAt: device.longest.endedAt,
        durationSeconds: device.longest.durationSeconds,
        open: device.longest.open,
      };
    }

    if (
      device.lastOutageAt &&
      (!lastOutageAt || device.lastOutageAt > lastOutageAt)
    ) {
      lastOutageAt = device.lastOutageAt;
    }

    if (
      device.lastRecoveryAt &&
      (!lastConfirmedRecoveryAt ||
        device.lastRecoveryAt > lastConfirmedRecoveryAt)
    ) {
      lastConfirmedRecoveryAt = device.lastRecoveryAt;
    }
  }

  return {
    total,
    devicesAffected,
    totalDowntimeDeviceSeconds,
    longest,
    lastOutageAt,
    lastConfirmedRecoveryAt,
  };
}

/**
 * Per-device rows for the contract, ordered by downtime DESC then name. This is
 * ordering by an objective measure, not an intelligent ranking.
 */
export function deviceRows(
  devices: DeviceReliabilityInput[],
): ReliabilityDeviceRow[] {
  return devices
    .map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      deviceType: device.deviceType,
      monitoringMode: device.monitoringMode,
      currentLinkState: device.currentLinkState,
      availabilityPercentage: device.percentage,
      confirmedAvailabilityPercentage: device.confirmedAvailabilityPercentage,
      coveragePercentage: device.coveragePercentage,
      uptimeSeconds: device.totals.uptimeSeconds,
      downtimeSeconds: device.totals.downtimeSeconds,
      unknownSeconds: deviceUnknownSeconds(device),
      outageCount: device.intervals.length,
      longestOutageSeconds: device.longest?.durationSeconds ?? 0,
      lastOutageAt: device.lastOutageAt,
    }))
    .sort(
      (first, second) =>
        second.downtimeSeconds - first.downtimeSeconds ||
        first.name.localeCompare(second.name),
    );
}

const MONITORED_DIRECT_DEVICE_TYPES: readonly DeviceType[] = [
  'CAMERA',
  'RECORDER',
  'GATEWAY',
];

/**
 * Why a device is not in the reliability population. Mirrors the eligibility
 * predicate of `DeviceRepository.findAllReliabilityEligibleDevicesWithSite`:
 *
 *   eligible = status = ACTIVE
 *            ∧ ( (DIRECT     ∧ type ∈ {CAMERA,RECORDER,GATEWAY})
 *              ∨ (VIA_GATEWAY ∧ type = CAMERA ∧ gatewayDeviceId set) )
 *
 * Structural non-observability is reported first (it holds regardless of
 * status); a structurally-observable device that is still excluded can only be
 * so because `device.status !== ACTIVE`
 * (INACTIVE / MAINTENANCE / DECOMMISSIONED, reported together as
 * ADMINISTRATIVE_STATUS_NOT_ACTIVE). PSOP's ingestion paths already reject
 * non-ACTIVE devices, so their telemetry could only ever go stale.
 */
export function classifyExclusion(device: {
  status: DeviceStatus;
  monitoringMode: DeviceMonitoringMode;
  deviceType: DeviceType;
  gatewayDeviceId: string | null;
}): ReliabilityExclusionReason {
  // 1. Structural non-observability — independent of administrative status.
  if (device.monitoringMode === 'INVENTORY_ONLY') {
    return 'INVENTORY_ONLY';
  }

  if (device.monitoringMode === 'VIA_GATEWAY') {
    if (device.deviceType !== 'CAMERA') {
      return 'GATEWAY_CHILD_NOT_CAMERA';
    }
    if (!device.gatewayDeviceId) {
      return 'GATEWAY_CHILD_WITHOUT_RECORDER';
    }
  } else if (!MONITORED_DIRECT_DEVICE_TYPES.includes(device.deviceType)) {
    // DIRECT with a non-monitored device type.
    return 'DEVICE_TYPE_NOT_MONITORED';
  }

  // 2. Structurally observable, so the only remaining reason to be excluded is
  //    an administrative status other than ACTIVE.
  if (device.status !== 'ACTIVE') {
    return 'ADMINISTRATIVE_STATUS_NOT_ACTIVE';
  }

  // Unreachable for a genuinely-excluded device (structurally observable +
  // ACTIVE would be eligible). Kept total for the type system.
  return 'DEVICE_TYPE_NOT_MONITORED';
}

/** Honest, always-present caveats for the reliability contract. */
export function reliabilityLimitations(
  scope: 'site' | 'fleet',
  aggregate: AggregateAvailability,
  eligibleDeviceCount: number,
): string[] {
  const subject = scope === 'site' ? 'site' : 'fleet';
  const limitations: string[] = [];

  limitations.push(
    `aggregateAvailability is availability aggregated by DEVICE-TIME across ` +
      `${eligibleDeviceCount} eligible device(s): every device-second is ` +
      `weighted equally. It is NOT a statement that the ${subject} as a ` +
      `service was operational X% of the period — that would need a separate ` +
      `service-level definition this V1 does not assume.`,
  );

  limitations.push(
    'aggregateAvailability.percentage is a number ONLY when every eligible ' +
      'device is fully covered by confirmed ONLINE/OFFLINE observation for the ' +
      'whole period (unknownDeviceSeconds === 0, i.e. no UNKNOWN/NEVER_SEEN/' +
      'NO_DATA device-time). Otherwise it is null with unavailableReason set; ' +
      'use confirmedAvailabilityPercentage over the observed device-time and ' +
      'coveragePercentage to see how much that is. Partial coverage is never ' +
      'promoted to an official figure and missing information is never counted ' +
      'as uptime.',
  );

  limitations.push(
    'The *_DeviceSeconds totals are summed from per-device Availability V1 ' +
      'figures, each rounded to whole seconds, so confirmedDeviceSeconds and ' +
      'expectedDeviceSeconds can differ by a few seconds even at full coverage. ' +
      'That slack never changes the percentage gate, which is ' +
      'unknownDeviceSeconds === 0.',
  );

  limitations.push(
    'Population = devices with status ACTIVE that are individually observable. ' +
      'INACTIVE / MAINTENANCE / DECOMMISSIONED devices are excluded ' +
      '(counted under population.excludedByReason.' +
      'ADMINISTRATIVE_STATUS_NOT_ACTIVE) because PSOP ingestion already rejects ' +
      'their telemetry; their individual history stays available at ' +
      'GET /devices/:id/availability. Planned-maintenance windows may get their ' +
      'own semantics in a later version.',
  );

  limitations.push(
    scope === 'site'
      ? 'The fleet/organization figure is recomputed from device-seconds, not ' +
          'as a mean of site percentages — a 1-device site never carries the ' +
          'same weight as a 100-device site.'
      : 'aggregateAvailability is recomputed from the total device-seconds of ' +
          'every site, NOT as a mean of the per-site percentages.',
  );

  limitations.push(
    'current.* is the live connectivity count from Health Engine V2 and is ' +
      'independent of the requested history window. Collection PARTIAL/FAILED ' +
      'does not change it; health DEGRADED/CRITICAL is never counted as ' +
      'OFFLINE or as downtime.',
  );

  limitations.push(
    'When a recorder loses observability its child cameras become UNKNOWN, ' +
      'which lowers coverage — it is never counted as child downtime, and a ' +
      'recorder outage is one outage, not one per observed child.',
  );

  limitations.push(
    'There is no reliability score, risk score, severity or ranking. Devices ' +
      'and sites are ordered by downtime (an objective measure) only.',
  );

  limitations.push(
    'Performance: each eligible device is reconstructed with its own ' +
      'connectivity-history read (Availability V1 pipeline), bounded ' +
      'concurrency. Correct but O(devices) storage reads per call; no ' +
      'materialized aggregate exists in V1.',
  );

  if (aggregate.unavailableReason === 'NO_ELIGIBLE_DEVICES') {
    limitations.push(
      `This ${subject} has no operationally-monitored devices; every ` +
        'availability figure is null (never 100%).',
    );
  }

  return limitations;
}

export function tallyExclusions(
  devices: Array<{
    status: DeviceStatus;
    monitoringMode: DeviceMonitoringMode;
    deviceType: DeviceType;
    gatewayDeviceId: string | null;
  }>,
): Partial<Record<ReliabilityExclusionReason, number>> {
  const tally: Partial<Record<ReliabilityExclusionReason, number>> = {};

  for (const device of devices) {
    const reason = classifyExclusion(device);
    tally[reason] = (tally[reason] ?? 0) + 1;
  }

  return tally;
}
