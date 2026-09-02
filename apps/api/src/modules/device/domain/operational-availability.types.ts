/**
 * PSOP Operational History & Availability V1 — shared domain types.
 *
 * This layer answers "when / how long / how often was this device unreachable,
 * and what was its availability in a period?" It is **additive and read-only**
 * and it never re-implements the Operational Health Engine V2:
 *
 *  - the CURRENT state comes verbatim from `DeviceTelemetryService.findByDeviceId`
 *    (Health Engine V2), never recomputed here;
 *  - the HISTORY is reconstructed from `DeviceConnectivityEvent` rows — the
 *    transition log the connectivity monitor already persists.
 *
 * Downtime in V1 is **connectivity only**: a device is "down" while its
 * `connectivity.linkState` is `OFFLINE`. Health `DEGRADED`/`CRITICAL`, the
 * legacy `DEGRADED` alias, and collection `PARTIAL`/`FAILED` are NOT downtime.
 * `UNKNOWN` (stale observation / invalid timestamp) and `NEVER_SEEN` are NOT
 * confirmed downtime either — they are surfaced separately and excluded from
 * the availability denominator so uptime never hides a period we could not
 * actually observe.
 */

import type { LinkState } from './operational-health.types.js';

/**
 * The per-segment verdict used while walking the reconstructed timeline.
 *
 *  - `ONLINE` / `OFFLINE` / `UNKNOWN` / `NEVER_SEEN` — a real `LinkState`
 *    PSOP concluded for that sub-interval.
 *  - `NO_DATA` — PSOP had no knowledge at all for that sub-interval (before the
 *    first ever event, or a gap the retention window can no longer cover).
 */
export type AvailabilitySegmentState = LinkState | 'NO_DATA';

export type AvailabilityWindowPreset = '24h' | '7d' | '30d';

export type AvailabilityUnavailableReason =
  /** No connectivity history exists for the device in (or before) the period. */
  | 'NO_HISTORY'
  /**
   * History exists but every sub-interval in the period is UNKNOWN / NEVER_SEEN
   * / NO_DATA — there is no ONLINE or OFFLINE time to divide.
   */
  | 'NO_CONFIRMED_OBSERVATION'
  /**
   * Part of the period is UNKNOWN / NEVER_SEEN / NO_DATA. A period-level
   * availability figure would be misleading, so `percentage` is `null`; use
   * `confirmedAvailabilityPercentage` for the figure over observed time only.
   */
  | 'INCOMPLETE_COVERAGE';

/** How an OFFLINE interval stopped being OFFLINE. */
export type AvailabilityOutageEndState =
  /** A confirmed recovery — the link transitioned back to ONLINE. */
  | 'ONLINE'
  /** Confirmed downtime stopped, but the equipment did NOT confirm recovery. */
  | 'UNKNOWN'
  | 'NEVER_SEEN';

/** How PSOP learned about an outage (mirrors the persisted connectivity context). */
export interface AvailabilityEvidence {
  /** `DIRECT` | `RECORDER_OBSERVED` | `GATEWAY_DERIVED` | `NOT_MONITORED`. */
  monitoringSource: string | null;
  /** `DIRECT` | `RECORDER_VERIFIED` | `NOT_VERIFIED` | `NOT_MONITORED`. */
  individualVerification: string | null;
  observerDeviceId: string | null;
  observerDeviceName: string | null;
  channelNumber: number | null;
  /** Structured link reason codes at detection time (e.g. `HEARTBEAT_OVERDUE`). */
  reasonCodes: string[];
}

export interface AvailabilityOutageInterval extends AvailabilityEvidence {
  /** Outage start clamped to the requested window. */
  startedAt: string;
  /** Outage end clamped to the window; `null` while the outage is still open. */
  endedAt: string | null;
  /** In-window duration in seconds (what the availability math uses). */
  durationSeconds: number;
  /** True while the device is still OFFLINE at the end of the window / now. */
  open: boolean;
  /** Which boundary of this interval was cut by the requested window. */
  clipped: {
    start: boolean;
    end: boolean;
  };
  /**
   * The real transition instant PSOP recorded, even when it precedes the
   * window. This is the *detection* time (monitor cadence ~60s), not the exact
   * physical moment the link dropped.
   */
  actualStartedAt: string;
  actualEndedAt: string | null;
  /** Full outage duration when both ends are known, else `null`. */
  actualDurationSeconds: number | null;
  /**
   * `detectedAt - lastHeartbeatAt` on the opening event when available — how
   * long telemetry had already been silent before PSOP declared OFFLINE. A
   * recorder-verified OFFLINE is authoritative and not debounced, and because
   * the recorder reports the channel in near-real time this value is normally
   * `0` and occasionally rounds to `1` (sub-second gap). It is NOT forced to
   * zero — do not rely on an exact-`0` guarantee.
   */
  detectionLatencySeconds: number | null;
  /**
   * The state the OFFLINE run transitioned into. `null` while the interval is
   * still open or clipped at a historical window end.
   */
  endedByState: AvailabilityOutageEndState | null;
  /**
   * `true` ONLY when `endedByState === 'ONLINE'` — the equipment actually
   * confirmed it was back. An OFFLINE → UNKNOWN / NEVER_SEEN transition ends the
   * *confirmed downtime accounting* but is NOT a recovery.
   */
  recoveryConfirmed: boolean;
  /**
   * Link reason codes on the recovering event — populated only when
   * `recoveryConfirmed` is `true` and a transition event carried them.
   */
  recoveryReasonCodes: string[] | null;
}

export interface DeviceAvailability {
  deviceId: string;
  generatedAt: string;

  device: {
    id: string;
    name: string;
    externalId: string;
    deviceType: string;
    monitoringMode: string;
    site: {
      id: string;
      code: string;
      name: string;
    };
  };

  monitoring: {
    source: string;
    individualVerification: string;
    observerDeviceId: string | null;
    observerDeviceName: string | null;
  };

  period: {
    /** Exactly what the caller asked for. */
    requestedFrom: string;
    requestedTo: string;
    /** Effective bounds used for the math (`to` is clamped to `generatedAt`). */
    from: string;
    to: string;
    durationSeconds: number;
    window: AvailabilityWindowPreset | null;
    clampedToNow: boolean;
  };

  /**
   * The device state RIGHT NOW. Independent of `from` / `to` — the requested
   * window only governs the historical reconstruction, never this block.
   */
  current: {
    /** Verbatim from the Health Engine V2 — never recomputed here. */
    linkState: LinkState | null;
    outageOpen: boolean;
    /**
     * Real start of the outage that is open now, reconstructed ONLY from the
     * device's most recent connectivity transitions up to `now` — never from
     * the in-window reconstruction, even when the window carries its own open
     * outage. The start may be before OR after the requested window. `null`
     * when retained history cannot locate it (a limitation then says the start
     * could not be reconstructed from retained connectivity history).
     */
    outageStartedAt: string | null;
    /** `true` only if that start is inside `[from, to]`. `null` if no open outage. */
    outageStartedWithinWindow: boolean | null;
    /** Link reason codes for the current outage, when open. */
    reasonCodes: string[];
  };

  availability: {
    /**
     * Availability of the **whole period**. A number ONLY when the period is
     * fully covered by confirmed observation (`unknownSeconds`,
     * `neverSeenSeconds` and `noDataSeconds` are all `0`). Any gap ⇒ `null`
     * with `unavailableReason` set — never a misleading figure over a sliver
     * of the period.
     */
    percentage: number | null;
    /**
     * `uptimeSeconds / confirmedObservedSeconds * 100` — availability over the
     * time PSOP actually observed a verdict, ignoring the gaps. `null` when
     * there is no confirmed time at all. This is explicitly NOT "availability
     * of the period".
     */
    confirmedAvailabilityPercentage: number | null;
    unavailableReason: AvailabilityUnavailableReason | null;
    uptimeSeconds: number;
    downtimeSeconds: number;
    unknownSeconds: number;
    neverSeenSeconds: number;
    noDataSeconds: number;
    /** uptime + downtime — the only time with a confirmed link verdict. */
    confirmedObservedSeconds: number;
    /** confirmedObservedSeconds / durationSeconds * 100 — the period's observation coverage. */
    coveragePercentage: number;
  };

  outages: {
    count: number;
    totalDowntimeSeconds: number;
    longestSeconds: number;
    longest: AvailabilityOutageInterval | null;
    /** `startedAt` of the most recent outage overlapping the window. */
    lastOutageAt: string | null;
    /**
     * `endedAt` of the most recent **confirmed recovery** (OFFLINE → ONLINE)
     * in the window. An OFFLINE → UNKNOWN / NEVER_SEEN transition never sets
     * this.
     */
    lastRecoveryAt: string | null;
    openOutage: AvailabilityOutageInterval | null;
  };

  intervals: AvailabilityOutageInterval[];

  coverage: {
    eventCount: number;
    firstEventAt: string | null;
    lastEventAt: string | null;
    hasAnchorBeforeWindow: boolean;
    /** True when the event page hit its safety cap and older detail may be missing. */
    truncated: boolean;
  };

  limitations: string[];
}
