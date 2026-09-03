/**
 * PSOP Site & Fleet Reliability V1 — shared domain types.
 *
 * This layer answers "how reliable has this SITE / the whole FLEET been over a
 * period?" It is **additive and strictly read-only** and it never re-implements
 * the Operational Health Engine V2 or the Availability V1 math:
 *
 *  - the CURRENT state of every device comes verbatim from Health Engine V2
 *    (`DeviceTelemetryService`), never recomputed here;
 *  - the HISTORY of every device is reconstructed by
 *    `DeviceAvailabilityService.reconstructForResolvedDevice` — the exact same
 *    pipeline that backs `GET /devices/:id/availability`.
 *
 * The aggregate unit is **device-time** (device-seconds). For a population of N
 * eligible devices over a period of T seconds:
 *
 *   expectedDeviceSeconds   = T * N
 *   uptimeDeviceSeconds     = Σ device.availability.uptimeSeconds
 *   downtimeDeviceSeconds   = Σ device.availability.downtimeSeconds
 *   unknownDeviceSeconds    = Σ (unknownSeconds + neverSeenSeconds + noDataSeconds)
 *   confirmedDeviceSeconds  = uptimeDeviceSeconds + downtimeDeviceSeconds
 *
 *   coveragePercentage              = confirmedDeviceSeconds / expectedDeviceSeconds * 100
 *   confirmedAvailabilityPercentage = uptimeDeviceSeconds   / confirmedDeviceSeconds * 100
 *
 * `aggregateAvailability.percentage` is a NUMBER only when the WHOLE eligible
 * population is fully observed for the WHOLE period (`eligibleDeviceCount > 0`,
 * `confirmedDeviceSeconds > 0` and `unknownDeviceSeconds === 0`, where
 * `unknownDeviceSeconds` is the sum of UNKNOWN + NEVER_SEEN + NO_DATA
 * device-seconds). Otherwise it is `null` with `unavailableReason` set —
 * partial coverage never becomes an official figure, and missing information is
 * never counted as uptime.
 *
 * `confirmedDeviceSeconds` and `expectedDeviceSeconds` can differ by a few
 * seconds because per-device Availability V1 rounds each segment/bucket to
 * whole seconds. That sub-second slack can never turn genuine
 * UNKNOWN/NEVER_SEEN/NO_DATA time into confirmed coverage — the gate is
 * `unknownDeviceSeconds === 0`, not an integer equality of the two totals.
 *
 * Population: only devices with `status === ACTIVE` are aggregated (plus the
 * existing observability rules). A non-ACTIVE device stays queryable
 * individually via `GET /devices/:id/availability`; it is just not part of the
 * current fleet-reliability population.
 *
 * This metric is deliberately NOT called "site uptime": it is availability
 * aggregated by device-time, not a statement that the site as a service was
 * operational X% of the period. There is no reliability score, risk score or
 * ranking anywhere in this contract.
 */

import type { LinkState } from '../../device/domain/operational-health.types.js';
import type { AvailabilityWindowPreset } from '../../device/domain/operational-availability.types.js';

export type AggregateUnavailableReason =
  /** The population has no eligible devices. `percentage` is null, never 100%. */
  | 'NO_ELIGIBLE_DEVICES'
  /**
   * Devices exist but not a single second of confirmed ONLINE / OFFLINE time
   * was observed across the whole population — nothing to divide.
   */
  | 'NO_CONFIRMED_OBSERVATION'
  /**
   * Part of the population's device-time is UNKNOWN / NEVER_SEEN / NO_DATA. A
   * population-level figure would be misleading, so `percentage` is null; use
   * `confirmedAvailabilityPercentage` over the observed device-time only and
   * `coveragePercentage` to see how much that is.
   */
  | 'INCOMPLETE_COVERAGE';

/** Why a device was excluded from the reliability population. */
export type ReliabilityExclusionReason =
  /** monitoringMode === INVENTORY_ONLY — not operationally monitored at all. */
  | 'INVENTORY_ONLY'
  /** DIRECT device whose deviceType is not CAMERA / RECORDER / GATEWAY. */
  | 'DEVICE_TYPE_NOT_MONITORED'
  /** VIA_GATEWAY device that is not a CAMERA. */
  | 'GATEWAY_CHILD_NOT_CAMERA'
  /** VIA_GATEWAY camera with no recorder/gateway assigned. */
  | 'GATEWAY_CHILD_WITHOUT_RECORDER'
  /**
   * Structurally observable, but `device.status` is not ACTIVE
   * (INACTIVE / MAINTENANCE / DECOMMISSIONED counted together). The device is
   * administratively out of the operational fleet; its individual history is
   * still available at `GET /devices/:id/availability`.
   */
  | 'ADMINISTRATIVE_STATUS_NOT_ACTIVE';

export interface ReliabilityPeriod {
  /** Exactly what the caller asked for. */
  requestedFrom: string;
  requestedTo: string;
  /** Effective bounds used for the math (`to` is clamped to `generatedAt`). */
  from: string;
  to: string;
  durationSeconds: number;
  window: AvailabilityWindowPreset | null;
  clampedToNow: boolean;
}

/**
 * Live connectivity counts, straight from Health Engine V2. Collection
 * PARTIAL/FAILED never changes these; health DEGRADED/CRITICAL never becomes
 * OFFLINE.
 */
export interface ReliabilityCurrentCounts {
  online: number;
  offline: number;
  unknown: number;
  neverSeen: number;
}

export interface AggregateAvailability {
  /**
   * Availability of the WHOLE period for the WHOLE eligible population. A number
   * ONLY when `unknownDeviceSeconds === 0` and `confirmedDeviceSeconds > 0`.
   * Any coverage gap ⇒ `null` with `unavailableReason` set.
   */
  percentage: number | null;
  /**
   * `uptimeDeviceSeconds / confirmedDeviceSeconds * 100` — availability over the
   * device-time actually observed, ignoring the gaps. `null` when there is no
   * confirmed device-time. Explicitly NOT "availability of the period".
   */
  confirmedAvailabilityPercentage: number | null;
  /**
   * `confirmedDeviceSeconds / expectedDeviceSeconds * 100` — how much of the
   * expected device-time PSOP actually has a confirmed verdict for. `null` when
   * there is no eligible population.
   */
  coveragePercentage: number | null;
  uptimeDeviceSeconds: number;
  downtimeDeviceSeconds: number;
  /** unknown + neverSeen + noData device-seconds combined. */
  unknownDeviceSeconds: number;
  expectedDeviceSeconds: number;
  confirmedDeviceSeconds: number;
  unavailableReason: AggregateUnavailableReason | null;
}

/** An objective "longest outage" pointer — plain ordering by duration, no ranking. */
export interface ReliabilityLongestOutage {
  deviceId: string;
  deviceName: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  open: boolean;
}

export interface ReliabilityOutageSummary {
  /** Σ of every device's OFFLINE-interval count in the period. */
  total: number;
  /** Distinct devices with at least one OFFLINE interval — no double counting. */
  devicesAffected: number;
  /** Σ downtime device-seconds (identical to aggregate downtimeDeviceSeconds). */
  totalDowntimeDeviceSeconds: number;
  /** Longest single OFFLINE interval across the population (by duration). */
  longest: ReliabilityLongestOutage | null;
  /** `startedAt` of the most recent OFFLINE interval across the population. */
  lastOutageAt: string | null;
  /** `endedAt` of the most recent CONFIRMED recovery (OFFLINE → ONLINE). */
  lastConfirmedRecoveryAt: string | null;
}

/**
 * Per-device row. `availabilityPercentage` / `confirmedAvailabilityPercentage`
 * / `coveragePercentage` are the individual device's Availability V1 figures,
 * unchanged. Rows are ordered by `downtimeSeconds` DESC (an objective measure),
 * then by name — this is ordering, not an intelligent ranking.
 */
export interface ReliabilityDeviceRow {
  deviceId: string;
  name: string;
  deviceType: string;
  monitoringMode: string;
  currentLinkState: LinkState | null;
  availabilityPercentage: number | null;
  confirmedAvailabilityPercentage: number | null;
  coveragePercentage: number;
  uptimeSeconds: number;
  downtimeSeconds: number;
  /** unknown + neverSeen + noData seconds for this device. */
  unknownSeconds: number;
  outageCount: number;
  longestOutageSeconds: number;
  lastOutageAt: string | null;
}

export interface ReliabilityPopulation {
  eligibleDevices: number;
  excludedDevices: number;
  excludedByReason: Partial<Record<ReliabilityExclusionReason, number>>;
}

export interface SiteReliability {
  generatedAt: string;
  site: {
    id: string;
    code: string;
    name: string;
    timezone: string;
    status: string;
  };
  period: ReliabilityPeriod;
  population: ReliabilityPopulation;
  current: ReliabilityCurrentCounts;
  aggregateAvailability: AggregateAvailability;
  outages: ReliabilityOutageSummary;
  devices: ReliabilityDeviceRow[];
  limitations: string[];
}

export interface FleetSiteRow {
  siteId: string;
  siteName: string;
  code: string;
  eligibleDevices: number;
  currentOffline: number;
  availabilityPercentage: number | null;
  confirmedAvailabilityPercentage: number | null;
  coveragePercentage: number | null;
  uptimeDeviceSeconds: number;
  downtimeDeviceSeconds: number;
  outageCount: number;
  unavailableReason: AggregateUnavailableReason | null;
}

export interface FleetReliability {
  generatedAt: string;
  organizationId: string;
  period: ReliabilityPeriod;
  population: {
    sites: number;
    sitesWithEligibleDevices: number;
    eligibleDevices: number;
    excludedDevices: number;
    excludedByReason: Partial<Record<ReliabilityExclusionReason, number>>;
  };
  current: ReliabilityCurrentCounts;
  aggregateAvailability: AggregateAvailability;
  outages: ReliabilityOutageSummary;
  /** Ordered by downtimeDeviceSeconds DESC, then name. Ordering, not ranking. */
  sites: FleetSiteRow[];
  limitations: string[];
}
