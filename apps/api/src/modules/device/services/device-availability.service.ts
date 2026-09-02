import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { LinkState } from '../domain/operational-health.types.js';
import type {
  AvailabilitySegmentState,
  AvailabilityUnavailableReason,
  AvailabilityWindowPreset,
  DeviceAvailability,
  AvailabilityOutageInterval,
} from '../domain/operational-availability.types.js';
import type { DeviceAvailabilityQueryDto } from '../dto/device-availability-query.dto.js';
import {
  DeviceRepository,
  type DeviceWithSite,
} from '../repositories/device.repository.js';
import { DeviceConnectivityEventsService } from './device-connectivity-events.service.js';
import { DeviceTelemetryService } from './device-telemetry.service.js';

/** Largest period the endpoint will reconstruct in a single call. */
const MAX_WINDOW_SECONDS = 400 * 86400;

const WINDOW_PRESET_SECONDS: Record<AvailabilityWindowPreset, number> = {
  '24h': 24 * 3600,
  '7d': 7 * 86400,
  '30d': 30 * 86400,
};

const LINK_STATES = new Set<LinkState>([
  'ONLINE',
  'OFFLINE',
  'UNKNOWN',
  'NEVER_SEEN',
]);

interface ParsedEvent {
  detectedAtMs: number;
  linkState: LinkState;
  eventType: string | null;
  previousState: string | null;
  reasonCodes: string[];
  monitoringSource: string | null;
  individualVerification: string | null;
  observerDeviceId: string | null;
  observerDeviceName: string | null;
  channelNumber: number | null;
  lastHeartbeatAtMs: number | null;
  ageSeconds: number | null;
}

interface Boundary {
  atMs: number;
  state: AvailabilitySegmentState;
  /** The transition that produced this boundary, or `null` for the synthetic start. */
  event: ParsedEvent | null;
}

interface ResolvedPeriod {
  requestedFrom: string;
  requestedTo: string;
  fromMs: number;
  toMs: number;
  window: AvailabilityWindowPreset | null;
  /** The caller asked for a `to` in the future and it was pulled back to now. */
  clampedToNow: boolean;
  /** The effective window end is "now" (a preset window, or a clamped future `to`). */
  endsAtNow: boolean;
}

type OperationalSnapshot = Awaited<
  ReturnType<DeviceTelemetryService['findByDeviceId']>
>;

@Injectable()
export class DeviceAvailabilityService {
  constructor(
    private readonly deviceRepository: DeviceRepository,
    private readonly connectivityEventsService: DeviceConnectivityEventsService,
    private readonly deviceTelemetryService: DeviceTelemetryService,
  ) {}

  async getAvailability(
    deviceId: string,
    organizationId: string,
    query: DeviceAvailabilityQueryDto,
  ): Promise<DeviceAvailability> {
    const device = await this.deviceRepository.findByIdWithSite(
      deviceId,
      organizationId,
    );

    // Tenant isolation: a device outside the caller's organization is
    // indistinguishable from one that does not exist.
    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (!this.isIndividuallyObservable(device)) {
      throw new BadRequestException(
        'Availability history is available only for directly monitored devices or recorder-observed cameras',
      );
    }

    const now = new Date();
    const period = this.resolvePeriod(query, now);

    const operational = await this.deviceTelemetryService.findByDeviceId(
      deviceId,
      organizationId,
    );

    const { anchor, events, truncated } =
      await this.connectivityEventsService.collectEventWindow(
        deviceId,
        new Date(period.fromMs),
        new Date(period.toMs),
      );

    const parsedAnchor = anchor ? this.parseEvent(anchor) : null;
    const parsedEvents = events
      .map((event) => this.parseEvent(event))
      .sort((first, second) => first.detectedAtMs - second.detectedAtMs);

    const boundaries = this.buildBoundaries(period, parsedAnchor, parsedEvents);

    const totals = this.accumulate(boundaries, period.toMs);
    const intervals = this.buildIntervals(
      boundaries,
      period,
      parsedAnchor,
      operational,
    );

    const durationSeconds = Math.max(
      0,
      Math.floor((period.toMs - period.fromMs) / 1000),
    );

    const confirmedObservedSeconds =
      totals.uptimeSeconds + totals.downtimeSeconds;

    const hasHistory = Boolean(parsedAnchor) || parsedEvents.length > 0;

    // Any UNKNOWN / NEVER_SEEN / NO_DATA time is a coverage gap: PSOP did not
    // observe a verdict for the whole period.
    const hasCoverageGap =
      totals.unknownSeconds > 0 ||
      totals.neverSeenSeconds > 0 ||
      totals.noDataSeconds > 0;

    const unavailableReason: AvailabilityUnavailableReason | null = !hasHistory
      ? 'NO_HISTORY'
      : confirmedObservedSeconds === 0
        ? 'NO_CONFIRMED_OBSERVATION'
        : hasCoverageGap
          ? 'INCOMPLETE_COVERAGE'
          : null;

    const confirmedAvailabilityPercentage =
      confirmedObservedSeconds > 0
        ? this.round4(
            (totals.uptimeSeconds / confirmedObservedSeconds) * 100,
          )
        : null;

    // `percentage` is availability of the WHOLE period — a number only when
    // the period is fully covered by confirmed observation.
    const percentage =
      unavailableReason === null ? confirmedAvailabilityPercentage : null;

    const coveragePercentage =
      durationSeconds > 0
        ? this.round4((confirmedObservedSeconds / durationSeconds) * 100)
        : 0;

    const openOutage = intervals.find((interval) => interval.open) ?? null;
    const confirmedRecoveries = intervals.filter(
      (interval) => interval.recoveryConfirmed,
    );

    const longest = intervals.reduce<AvailabilityOutageInterval | null>(
      (best, interval) =>
        !best || interval.durationSeconds > best.durationSeconds
          ? interval
          : best,
      null,
    );

    // `current.*` describes the device state RIGHT NOW and must not depend on
    // the requested history window at all. If the Health Engine reports the
    // link OFFLINE, the start of that outage is ALWAYS reconstructed from the
    // most recent connectivity transitions up to `now` — never from the
    // in-window reconstruction, even when the window has its own open outage.
    const currentOutageStartMs = await this.resolveCurrentOutageStart(
      device.id,
      operational,
      now,
    );

    const current = this.buildCurrent(operational, currentOutageStartMs, period);

    const observerDeviceName =
      intervals.find((interval) => interval.observerDeviceName)
        ?.observerDeviceName ?? null;

    const limitations = this.buildLimitations({
      totals,
      truncated,
      hasAnchor: Boolean(parsedAnchor),
      eventCount: parsedEvents.length,
      unavailableReason,
      current,
      operational,
      currentOutageStartMs,
      periodToMs: period.toMs,
    });

    return {
      deviceId: device.id,
      generatedAt: now.toISOString(),
      device: {
        id: device.id,
        name: device.name,
        externalId: device.externalId,
        deviceType: device.deviceType,
        monitoringMode: device.monitoringMode,
        site: {
          id: device.site.id,
          code: device.site.code,
          name: device.site.name,
        },
      },
      monitoring: {
        source: operational.monitoring.source,
        individualVerification: operational.monitoring.individualVerification,
        observerDeviceId: operational.monitoring.observerDeviceId,
        observerDeviceName,
      },
      period: {
        requestedFrom: period.requestedFrom,
        requestedTo: period.requestedTo,
        from: new Date(period.fromMs).toISOString(),
        to: new Date(period.toMs).toISOString(),
        durationSeconds,
        window: period.window,
        clampedToNow: period.clampedToNow,
      },
      current,
      availability: {
        percentage,
        confirmedAvailabilityPercentage,
        unavailableReason,
        uptimeSeconds: totals.uptimeSeconds,
        downtimeSeconds: totals.downtimeSeconds,
        unknownSeconds: totals.unknownSeconds,
        neverSeenSeconds: totals.neverSeenSeconds,
        noDataSeconds: totals.noDataSeconds,
        confirmedObservedSeconds,
        coveragePercentage,
      },
      outages: {
        count: intervals.length,
        totalDowntimeSeconds: totals.downtimeSeconds,
        longestSeconds: longest?.durationSeconds ?? 0,
        longest,
        lastOutageAt:
          intervals.length > 0
            ? intervals[intervals.length - 1].startedAt
            : null,
        // Only a confirmed OFFLINE -> ONLINE transition counts as a recovery.
        lastRecoveryAt:
          confirmedRecoveries.length > 0
            ? confirmedRecoveries[confirmedRecoveries.length - 1].endedAt
            : null,
        openOutage,
      },
      intervals,
      coverage: {
        eventCount: parsedEvents.length,
        firstEventAt:
          parsedEvents.length > 0
            ? new Date(parsedEvents[0].detectedAtMs).toISOString()
            : null,
        lastEventAt:
          parsedEvents.length > 0
            ? new Date(
                parsedEvents[parsedEvents.length - 1].detectedAtMs,
              ).toISOString()
            : null,
        hasAnchorBeforeWindow: Boolean(parsedAnchor),
        truncated,
      },
      limitations,
    };
  }

  // ---------------------------------------------------------------------------
  // eligibility
  // ---------------------------------------------------------------------------

  /** Mirrors `DeviceConnectivityEventsService.findByDeviceId` exactly. */
  private isIndividuallyObservable(device: DeviceWithSite): boolean {
    const isDirect =
      device.monitoringMode === 'DIRECT' &&
      ['CAMERA', 'RECORDER', 'GATEWAY'].includes(device.deviceType);

    const isRecorderObserved =
      device.monitoringMode === 'VIA_GATEWAY' &&
      device.deviceType === 'CAMERA' &&
      Boolean(device.gatewayDeviceId);

    return isDirect || isRecorderObserved;
  }

  // ---------------------------------------------------------------------------
  // period
  // ---------------------------------------------------------------------------

  private resolvePeriod(
    query: DeviceAvailabilityQueryDto,
    now: Date,
  ): ResolvedPeriod {
    const nowMs = now.getTime();

    let window: AvailabilityWindowPreset | null;
    let requestedFromMs: number;
    let requestedToMs: number;

    if (query.from) {
      window = null;
      requestedFromMs = Date.parse(query.from);
      requestedToMs = query.to ? Date.parse(query.to) : nowMs;
    } else {
      window = query.window ?? '24h';
      requestedToMs = nowMs;
      requestedFromMs = nowMs - WINDOW_PRESET_SECONDS[window] * 1000;
    }

    if (!Number.isFinite(requestedFromMs) || !Number.isFinite(requestedToMs)) {
      throw new BadRequestException('Invalid from/to timestamp');
    }

    if (requestedFromMs >= requestedToMs) {
      throw new BadRequestException('`from` must be strictly before `to`');
    }

    if (requestedFromMs > nowMs) {
      throw new BadRequestException('`from` is in the future');
    }

    if ((requestedToMs - requestedFromMs) / 1000 > MAX_WINDOW_SECONDS) {
      throw new BadRequestException(
        `The requested period exceeds the ${MAX_WINDOW_SECONDS / 86400}-day maximum`,
      );
    }

    const toMs = Math.min(requestedToMs, nowMs);

    return {
      requestedFrom: new Date(requestedFromMs).toISOString(),
      requestedTo: new Date(requestedToMs).toISOString(),
      fromMs: requestedFromMs,
      toMs,
      window,
      clampedToNow: requestedToMs > nowMs,
      endsAtNow: toMs >= nowMs - 1000,
    };
  }

  // ---------------------------------------------------------------------------
  // reconstruction
  // ---------------------------------------------------------------------------

  private buildBoundaries(
    period: ResolvedPeriod,
    anchor: ParsedEvent | null,
    events: ParsedEvent[],
  ): Boundary[] {
    // State the device was already in when the window opened.
    const startState: AvailabilitySegmentState = anchor
      ? anchor.linkState
      : 'NO_DATA';

    const byMs = new Map<number, Boundary>();

    byMs.set(period.fromMs, {
      atMs: period.fromMs,
      state: startState,
      event: null,
    });

    for (const event of events) {
      const atMs = Math.min(
        Math.max(event.detectedAtMs, period.fromMs),
        period.toMs,
      );

      // Later event at the same instant wins.
      byMs.set(atMs, { atMs, state: event.linkState, event });
    }

    return [...byMs.values()].sort((first, second) => first.atMs - second.atMs);
  }

  private accumulate(
    boundaries: Boundary[],
    endMs: number,
  ): {
    uptimeSeconds: number;
    downtimeSeconds: number;
    unknownSeconds: number;
    neverSeenSeconds: number;
    noDataSeconds: number;
  } {
    const totals = {
      uptimeSeconds: 0,
      downtimeSeconds: 0,
      unknownSeconds: 0,
      neverSeenSeconds: 0,
      noDataSeconds: 0,
    };

    for (let index = 0; index < boundaries.length; index += 1) {
      const start = boundaries[index].atMs;
      const stop =
        index + 1 < boundaries.length ? boundaries[index + 1].atMs : endMs;

      const seconds = Math.max(0, (stop - start) / 1000);

      switch (boundaries[index].state) {
        case 'ONLINE':
          totals.uptimeSeconds += seconds;
          break;
        case 'OFFLINE':
          totals.downtimeSeconds += seconds;
          break;
        case 'UNKNOWN':
          totals.unknownSeconds += seconds;
          break;
        case 'NEVER_SEEN':
          totals.neverSeenSeconds += seconds;
          break;
        default:
          totals.noDataSeconds += seconds;
      }
    }

    return {
      uptimeSeconds: Math.round(totals.uptimeSeconds),
      downtimeSeconds: Math.round(totals.downtimeSeconds),
      unknownSeconds: Math.round(totals.unknownSeconds),
      neverSeenSeconds: Math.round(totals.neverSeenSeconds),
      noDataSeconds: Math.round(totals.noDataSeconds),
    };
  }

  private buildIntervals(
    boundaries: Boundary[],
    period: ResolvedPeriod,
    anchor: ParsedEvent | null,
    operational: OperationalSnapshot,
  ): AvailabilityOutageInterval[] {
    const intervals: AvailabilityOutageInterval[] = [];
    const currentLinkOffline =
      operational.connectivity.linkState === 'OFFLINE';

    let runStartIndex: number | null = null;

    const flush = (endIndex: number) => {
      if (runStartIndex === null) {
        return;
      }

      const startBoundary = boundaries[runStartIndex];
      const openingEvent = startBoundary.event ?? anchor;
      const startedAtWindowMs = startBoundary.atMs;

      const closingBoundary =
        endIndex < boundaries.length ? boundaries[endIndex] : null;
      const closingEvent = closingBoundary?.event ?? null;

      const reachesWindowEnd = closingBoundary === null;
      const endWindowMs = closingBoundary?.atMs ?? period.toMs;

      // Was the opening boundary a real in-window transition, or the window
      // simply opening on an already-OFFLINE device?
      const startClipped = startBoundary.event === null;
      const actualStartedAtMs = startClipped
        ? (anchor?.detectedAtMs ?? startedAtWindowMs)
        : startBoundary.event!.detectedAtMs;

      let open = false;
      let endClipped = false;
      let endedAtMs: number | null = null;
      let actualEndedAtMs: number | null = null;
      let endedByState: 'ONLINE' | 'UNKNOWN' | 'NEVER_SEEN' | null = null;

      if (!reachesWindowEnd && closingEvent) {
        // The OFFLINE run stopped at a real transition. Confirmed downtime
        // ends here — but this is only a *recovery* if the link went ONLINE.
        endedAtMs = closingEvent.detectedAtMs;
        actualEndedAtMs = closingEvent.detectedAtMs;
        endedByState =
          closingEvent.linkState === 'ONLINE'
            ? 'ONLINE'
            : closingEvent.linkState === 'NEVER_SEEN'
              ? 'NEVER_SEEN'
              : 'UNKNOWN';
      } else {
        // The OFFLINE run touches the end of the window.
        endClipped = true;

        if (!period.endsAtNow) {
          // Historical `to`: the outage was still ongoing at `to`; we do not
          // know when (or if) it ended afterwards.
          open = false;
        } else if (currentLinkOffline) {
          open = true;
        } else {
          // The Health Engine says the device is no longer OFFLINE but the
          // monitor has not written the transition yet. It is a confirmed
          // recovery only if the current link state is ONLINE.
          open = false;
          endedAtMs = period.toMs;
          endedByState =
            operational.connectivity.linkState === 'ONLINE'
              ? 'ONLINE'
              : operational.connectivity.linkState === 'NEVER_SEEN'
                ? 'NEVER_SEEN'
                : 'UNKNOWN';
        }
      }

      const recoveryConfirmed = endedByState === 'ONLINE';
      const recoveryReasonCodes =
        recoveryConfirmed && closingEvent ? closingEvent.reasonCodes : null;

      const durationSeconds = Math.max(
        0,
        Math.round((endWindowMs - startedAtWindowMs) / 1000),
      );

      const actualDurationSeconds =
        actualEndedAtMs !== null
          ? Math.max(
              0,
              Math.round((actualEndedAtMs - actualStartedAtMs) / 1000),
            )
          : null;

      intervals.push({
        startedAt: new Date(startedAtWindowMs).toISOString(),
        endedAt: endedAtMs !== null ? new Date(endedAtMs).toISOString() : null,
        durationSeconds,
        open,
        clipped: { start: startClipped, end: endClipped },
        actualStartedAt: new Date(actualStartedAtMs).toISOString(),
        actualEndedAt:
          actualEndedAtMs !== null
            ? new Date(actualEndedAtMs).toISOString()
            : null,
        actualDurationSeconds,
        detectionLatencySeconds: this.detectionLatency(openingEvent),
        monitoringSource: openingEvent?.monitoringSource ?? null,
        individualVerification: openingEvent?.individualVerification ?? null,
        observerDeviceId: openingEvent?.observerDeviceId ?? null,
        observerDeviceName: openingEvent?.observerDeviceName ?? null,
        channelNumber: openingEvent?.channelNumber ?? null,
        reasonCodes: openingEvent?.reasonCodes ?? [],
        endedByState,
        recoveryConfirmed,
        recoveryReasonCodes,
      });

      runStartIndex = null;
    };

    for (let index = 0; index < boundaries.length; index += 1) {
      const isOffline = boundaries[index].state === 'OFFLINE';

      if (isOffline && runStartIndex === null) {
        runStartIndex = index;
      } else if (!isOffline && runStartIndex !== null) {
        flush(index);
      }
    }

    if (runStartIndex !== null) {
      flush(boundaries.length);
    }

    return intervals;
  }

  private buildCurrent(
    operational: OperationalSnapshot,
    currentOutageStartMs: number | null,
    period: ResolvedPeriod,
  ): DeviceAvailability['current'] {
    const linkState = operational.connectivity.linkState ?? null;
    const outageOpen = linkState === 'OFFLINE';

    if (!outageOpen) {
      return {
        linkState,
        outageOpen: false,
        outageStartedAt: null,
        outageStartedWithinWindow: null,
        reasonCodes: [],
      };
    }

    return {
      linkState,
      outageOpen: true,
      outageStartedAt:
        currentOutageStartMs !== null
          ? new Date(currentOutageStartMs).toISOString()
          : null,
      outageStartedWithinWindow:
        currentOutageStartMs !== null
          ? currentOutageStartMs >= period.fromMs &&
            currentOutageStartMs <= period.toMs
          : null,
      reasonCodes: operational.connectivity.reasons ?? [],
    };
  }

  /**
   * The start of the outage that is open RIGHT NOW, reconstructed ONLY from the
   * device's most recent connectivity transitions up to `now`. It is never
   * taken from the in-window reconstruction: the requested availability window
   * may carry its own open outage and still be irrelevant to the outage that
   * is running at this instant.
   *
   *  - Only meaningful when the Health Engine reports `linkState === 'OFFLINE'`.
   *  - The recent transitions are scanned newest -> oldest: repeated `OFFLINE`
   *    polls do not move the start; the run begins at the first `OFFLINE`
   *    transition that came from a non-`OFFLINE` state, and an intervening
   *    `ONLINE` / `UNKNOWN` / `NEVER_SEEN` ends the previous run so a later
   *    `OFFLINE` starts a new one.
   *  - Returns `null` when retained history (bounded by the event-retention
   *    horizon) cannot locate where the current run began: no transitions at
   *    all, the latest recorded transition is not `OFFLINE`, or the whole
   *    retained tail is `OFFLINE` with no non-`OFFLINE` predecessor. The caller
   *    then emits *"could not be reconstructed from retained connectivity
   *    history"* and never claims a transition was proven absent.
   */
  private async resolveCurrentOutageStart(
    deviceId: string,
    operational: OperationalSnapshot,
    now: Date,
  ): Promise<number | null> {
    if (operational.connectivity.linkState !== 'OFFLINE') {
      return null;
    }

    const recent =
      await this.connectivityEventsService.findRecentTransitions(deviceId, now);

    const parsed = recent
      .map((event) => this.parseEvent(event))
      .filter((event) => event.detectedAtMs <= now.getTime())
      .sort((first, second) => second.detectedAtMs - first.detectedAtMs);

    if (parsed.length === 0 || parsed[0].linkState !== 'OFFLINE') {
      return null;
    }

    // Walk newest -> oldest through the unbroken run of OFFLINE transitions.
    let candidateMs: number | null = null;

    for (const event of parsed) {
      if (event.linkState !== 'OFFLINE') {
        // An older non-OFFLINE transition ends the run: it began at the oldest
        // OFFLINE transition we have already seen.
        return candidateMs;
      }

      candidateMs = event.detectedAtMs;

      if (event.previousState && event.previousState !== 'OFFLINE') {
        // This OFFLINE transition came in from a non-OFFLINE state: definitive
        // start of the run.
        return candidateMs;
      }
    }

    // The whole retained tail was OFFLINE with no recorded non-OFFLINE
    // predecessor — retention cannot tell us where the run actually began.
    return null;
  }

  // ---------------------------------------------------------------------------
  // limitations
  // ---------------------------------------------------------------------------

  private buildLimitations(input: {
    totals: {
      unknownSeconds: number;
      neverSeenSeconds: number;
      noDataSeconds: number;
    };
    truncated: boolean;
    hasAnchor: boolean;
    eventCount: number;
    unavailableReason: AvailabilityUnavailableReason | null;
    current: DeviceAvailability['current'];
    operational: OperationalSnapshot;
    currentOutageStartMs: number | null;
    periodToMs: number;
  }): string[] {
    const limitations: string[] = [];

    limitations.push(
      'Downtime is connectivity-only: it counts time while connectivity.linkState ' +
        'is OFFLINE. Health DEGRADED/CRITICAL, the legacy DEGRADED alias and ' +
        'collection PARTIAL/FAILED are never counted as downtime.',
    );

    limitations.push(
      'Outage boundaries use PSOP’s detection time (connectivity monitor ' +
        'cadence, ~60s). A recorder-verified OFFLINE is authoritative and not ' +
        'debounced; a heartbeat-overdue OFFLINE is only declared after the ' +
        'offline window elapses (see detectionLatencySeconds).',
    );

    limitations.push(
      'A confirmed recovery is only an OFFLINE -> ONLINE transition ' +
        '(recoveryConfirmed / lastRecoveryAt). An OFFLINE -> UNKNOWN / ' +
        'NEVER_SEEN transition ends the confirmed downtime accounting but is ' +
        'never reported as a recovery.',
    );

    if (input.totals.unknownSeconds > 0) {
      limitations.push(
        `${input.totals.unknownSeconds}s of the period are UNKNOWN (stale ` +
          'observation / invalid timestamp) and are excluded from the ' +
          'availability denominator — they are never folded into uptime.',
      );
    }

    if (input.totals.neverSeenSeconds > 0) {
      limitations.push(
        `${input.totals.neverSeenSeconds}s of the period are NEVER_SEEN and ` +
          'are excluded from the availability denominator (not a confirmed outage).',
      );
    }

    if (input.totals.noDataSeconds > 0) {
      limitations.push(
        `${input.totals.noDataSeconds}s of the period have no connectivity ` +
          'history (before the first recorded transition, or beyond event ' +
          'retention) and are excluded from the availability denominator.',
      );
    }

    if (!input.hasAnchor && input.eventCount > 0) {
      limitations.push(
        'No connectivity transition is recorded before the window; the time ' +
          'before the first in-window event is treated as NO_DATA, not uptime.',
      );
    }

    if (input.truncated) {
      limitations.push(
        'The transition history hit the per-query page cap; some older ' +
          'intervals within this window may be missing.',
      );
    }

    if (input.current.outageOpen && input.current.outageStartedAt === null) {
      limitations.push(
        'The current outage start could not be reconstructed from retained ' +
          'connectivity history.',
      );
    }

    if (
      input.current.outageOpen &&
      input.currentOutageStartMs !== null &&
      input.currentOutageStartMs > input.periodToMs
    ) {
      limitations.push(
        'The current outage began after the end of the requested window. It ' +
          'is reported in current.* from the live device state and is ' +
          'deliberately not reflected in the historical availability, downtime ' +
          'or outage figures for this window.',
      );
    }

    if (input.unavailableReason === 'NO_HISTORY') {
      limitations.push(
        'availability.percentage is null: there is no connectivity history for ' +
          'this device in or before the requested period.',
      );
    }

    if (input.unavailableReason === 'NO_CONFIRMED_OBSERVATION') {
      limitations.push(
        'availability.percentage and confirmedAvailabilityPercentage are null: ' +
          'the period contains no ONLINE or OFFLINE time to divide (only ' +
          'UNKNOWN / NEVER_SEEN / NO_DATA).',
      );
    }

    if (input.unavailableReason === 'INCOMPLETE_COVERAGE') {
      limitations.push(
        'availability.percentage is null because part of the period is ' +
          'UNKNOWN / NEVER_SEEN / NO_DATA — a period-level figure would be ' +
          'misleading. confirmedAvailabilityPercentage gives availability over ' +
          'the observed time only; coveragePercentage says how much that is.',
      );
    }

    return limitations;
  }

  // ---------------------------------------------------------------------------
  // event parsing
  // ---------------------------------------------------------------------------

  private parseEvent(raw: Record<string, unknown>): ParsedEvent {
    const context = this.asObject(raw.context);

    const detectedAtMs =
      this.parseDateMs(raw.detected_at) ??
      this.toNumber(raw.timestamp) ??
      0;

    return {
      detectedAtMs,
      linkState: this.deriveLinkState(raw, context),
      eventType: this.toStringOrNull(raw.event_type),
      previousState: this.toStringOrNull(raw.previous_state),
      reasonCodes: this.toStringArray(context?.reasons),
      monitoringSource:
        this.toStringOrNull(context?.monitoringSource) ??
        this.toStringOrNull(raw.monitoring_source),
      individualVerification: this.toStringOrNull(
        context?.individualVerification,
      ),
      observerDeviceId:
        this.toStringOrNull(context?.observerDeviceId) ??
        this.toStringOrNull(raw.observer_device_id),
      observerDeviceName: this.toStringOrNull(context?.observerDeviceName),
      channelNumber:
        this.toNumber(context?.channelNumber) ??
        this.toNumber(raw.channel_number),
      lastHeartbeatAtMs:
        this.parseDateMs(context?.lastHeartbeatAt) ??
        this.parseDateMs(raw.last_heartbeat_at),
      ageSeconds:
        this.toNumber(context?.ageSeconds) ?? this.toNumber(raw.age_seconds),
    };
  }

  /**
   * The persisted event state (`current_state`) is the legacy 5-value alias.
   * The true link dimension is `context.linkState` when present; otherwise it
   * is derived from the alias (DEGRADED is a health state — the link is ONLINE).
   */
  private deriveLinkState(
    raw: Record<string, unknown>,
    context: Record<string, unknown> | null,
  ): LinkState {
    const fromContext = this.toStringOrNull(context?.linkState);
    if (fromContext && LINK_STATES.has(fromContext as LinkState)) {
      return fromContext as LinkState;
    }

    const alias = this.toStringOrNull(raw.current_state);
    if (alias === 'DEGRADED') {
      return 'ONLINE';
    }
    if (alias && LINK_STATES.has(alias as LinkState)) {
      return alias as LinkState;
    }

    return 'UNKNOWN';
  }

  private detectionLatency(event: ParsedEvent | null): number | null {
    if (!event) {
      return null;
    }

    if (event.lastHeartbeatAtMs !== null) {
      return Math.max(
        0,
        Math.round((event.detectedAtMs - event.lastHeartbeatAtMs) / 1000),
      );
    }

    return event.ageSeconds !== null ? Math.max(0, event.ageSeconds) : null;
  }

  // ---------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------

  private round4(value: number): number {
    return Math.round(value * 10000) / 10000;
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private toStringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  private toStringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private parseDateMs(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Epoch seconds vs milliseconds: connectivity events store ms.
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
}
