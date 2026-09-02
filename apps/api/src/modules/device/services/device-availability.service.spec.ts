import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DeviceAvailabilityService } from './device-availability.service.js';

/**
 * Unit coverage for the deterministic availability reconstruction: interval
 * rebuild, window boundaries, availability math, UNKNOWN handling, and the
 * "never invent downtime" rules. Full HTTP / Postgres scenarios live in
 * `test/device-availability.e2e-spec.ts`.
 */

const HOUR = 3600 * 1000;

function device(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dev-1',
    name: 'Camera One',
    externalId: 'CAM-01',
    deviceType: 'CAMERA',
    monitoringMode: 'DIRECT',
    gatewayDeviceId: null,
    site: { id: 'site-1', code: 'DFB-01', name: 'Deposito' },
    ...overrides,
  };
}

function operational(
  linkState: string | null,
  overrides: {
    source?: string;
    verification?: string;
    observerDeviceId?: string | null;
    reasons?: string[];
  } = {},
) {
  return {
    monitoring: {
      source: overrides.source ?? 'DIRECT',
      individualVerification: overrides.verification ?? 'DIRECT',
      observerDeviceId: overrides.observerDeviceId ?? null,
    },
    connectivity: {
      linkState,
      state: linkState === 'ONLINE' || linkState === null ? linkState : linkState,
      reasons: overrides.reasons ?? [],
    },
    health: { state: 'HEALTHY', reasons: [] },
    collection: { state: 'NOT_APPLICABLE', issues: [] },
  };
}

interface EvtOpts {
  alias?: string;
  eventType?: string;
  previousState?: string | null;
  reasons?: string[];
  monitoringSource?: string;
  individualVerification?: string;
  observerDeviceId?: string | null;
  observerDeviceName?: string | null;
  channelNumber?: number | null;
  lastHeartbeatAtMs?: number;
  ageSeconds?: number;
  linkStateInContext?: string | false;
}

function evt(detectedAtMs: number, linkState: string, opts: EvtOpts = {}) {
  const context: Record<string, unknown> = {
    reasons: opts.reasons ?? [],
    monitoringSource: opts.monitoringSource ?? 'DIRECT',
    individualVerification: opts.individualVerification ?? 'DIRECT',
    observerDeviceId: opts.observerDeviceId ?? null,
    observerDeviceName: opts.observerDeviceName ?? null,
    channelId: null,
    channelNumber: opts.channelNumber ?? null,
    lastHeartbeatAt:
      opts.lastHeartbeatAtMs != null
        ? new Date(opts.lastHeartbeatAtMs).toISOString()
        : null,
    ageSeconds: opts.ageSeconds ?? null,
  };

  if (opts.linkStateInContext !== false) {
    context.linkState = opts.linkStateInContext ?? linkState;
  }

  return {
    camera_id: 'dev-1',
    device_id: 'dev-1',
    timestamp: detectedAtMs,
    event_type: opts.eventType ?? 'CONNECTIVITY_CHANGED',
    previous_state: opts.previousState ?? null,
    current_state: opts.alias ?? linkState,
    detected_at: new Date(detectedAtMs).toISOString(),
    last_heartbeat_at:
      opts.lastHeartbeatAtMs != null
        ? new Date(opts.lastHeartbeatAtMs).toISOString()
        : null,
    age_seconds: opts.ageSeconds ?? null,
    context,
  };
}

function buildService(config: {
  device?: Record<string, unknown> | null;
  operational?: unknown;
  anchor?: Record<string, unknown> | null;
  events?: Record<string, unknown>[];
  truncated?: boolean;
  /**
   * Recent transitions (any order) returned by
   * `DeviceConnectivityEventsService.findRecentTransitions` — the history the
   * service scans to reconstruct the CURRENT outage start, independent of the
   * requested window. Defaults to the in-window `events`.
   */
  recentTransitions?: Record<string, unknown>[];
}) {
  const deviceRepository = {
    findByIdWithSite: jest
      .fn()
      .mockResolvedValue(
        config.device === undefined ? device() : config.device,
      ),
  };

  const connectivityEventsService = {
    collectEventWindow: jest.fn().mockResolvedValue({
      anchor: config.anchor ?? null,
      events: config.events ?? [],
      truncated: config.truncated ?? false,
    }),
    findRecentTransitions: jest
      .fn()
      .mockResolvedValue(config.recentTransitions ?? config.events ?? []),
  };

  const deviceTelemetryService = {
    findByDeviceId: jest
      .fn()
      .mockResolvedValue(config.operational ?? operational('ONLINE')),
  };

  const service = new DeviceAvailabilityService(
    deviceRepository as never,
    connectivityEventsService as never,
    deviceTelemetryService as never,
  );

  return { service, deviceRepository, connectivityEventsService };
}

/** A window that ends "now" (clampedToNow) so open-outage paths are exercised. */
function nowWindow(hoursBack: number) {
  const now = Date.now();
  return {
    now,
    query: {
      from: new Date(now - hoursBack * HOUR).toISOString(),
      to: new Date(now + HOUR).toISOString(),
    },
  };
}

/** A fully historical window (deterministic, clampedToNow = false). */
function pastWindow(startMs: number, endMs: number) {
  return { from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString() };
}

describe('DeviceAvailabilityService', () => {
  // 17 / 18 — tenant isolation & missing device
  it('18. throws NotFound when the device is not in the caller org', async () => {
    const { service } = buildService({ device: null });

    await expect(
      service.getAvailability('dev-1', 'org-1', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a device that is not individually observable', async () => {
    const { service } = buildService({
      device: device({ monitoringMode: 'INVENTORY_ONLY', deviceType: 'SENSOR' }),
    });

    await expect(
      service.getAvailability('dev-1', 'org-1', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // 19 — boundary validation
  it('19. rejects from >= to and future-only windows', async () => {
    const { service } = buildService({});

    await expect(
      service.getAvailability('dev-1', 'org-1', {
        from: '2026-08-10T00:00:00.000Z',
        to: '2026-08-09T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.getAvailability('dev-1', 'org-1', {
        from: new Date(Date.now() + 5 * HOUR).toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resolves the default 24h window and the presets', async () => {
    const { service } = buildService({ operational: operational('ONLINE') });

    const def = await service.getAvailability('dev-1', 'org-1', {});
    expect(def.period.window).toBe('24h');
    expect(def.period.durationSeconds).toBeGreaterThanOrEqual(24 * 3600 - 5);
    expect(def.period.durationSeconds).toBeLessThanOrEqual(24 * 3600 + 5);

    const week = await service.getAvailability('dev-1', 'org-1', {
      window: '7d',
    });
    expect(week.period.window).toBe('7d');
    expect(week.period.durationSeconds).toBeGreaterThanOrEqual(7 * 86400 - 5);
  });

  // 1 — always ONLINE
  it('1. device ONLINE for the whole period -> 100%, no outages', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 10 * HOUR;
    const { service } = buildService({
      operational: operational('ONLINE'),
      anchor: evt(start - HOUR, 'ONLINE'),
      events: [],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.availability.percentage).toBe(100);
    expect(result.availability.downtimeSeconds).toBe(0);
    expect(result.availability.uptimeSeconds).toBe(10 * 3600);
    expect(result.availability.coveragePercentage).toBe(100);
    expect(result.outages.count).toBe(0);
    expect(result.current.outageOpen).toBe(false);
  });

  // 2 — one closed outage
  it('2. one closed outage inside the window -> correct math + interval', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 10 * HOUR;
    const offAt = start + 2 * HOUR;
    const onAt = start + 3 * HOUR;

    const { service } = buildService({
      operational: operational('ONLINE'),
      anchor: evt(start - HOUR, 'ONLINE'),
      events: [
        evt(offAt, 'OFFLINE', {
          reasons: ['HEARTBEAT_OVERDUE'],
          lastHeartbeatAtMs: offAt - 120 * 1000,
        }),
        evt(onAt, 'ONLINE', { reasons: [] }),
      ],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.outages.count).toBe(1);
    expect(result.availability.downtimeSeconds).toBe(3600);
    expect(result.availability.uptimeSeconds).toBe(9 * 3600);
    expect(result.availability.percentage).toBe(90);

    const [interval] = result.intervals;
    expect(interval.open).toBe(false);
    expect(interval.durationSeconds).toBe(3600);
    expect(interval.clipped).toEqual({ start: false, end: false });
    expect(interval.startedAt).toBe(new Date(offAt).toISOString());
    expect(interval.endedAt).toBe(new Date(onAt).toISOString());
    expect(interval.reasonCodes).toEqual(['HEARTBEAT_OVERDUE']);
    expect(interval.detectionLatencySeconds).toBe(120);
    expect(result.outages.lastRecoveryAt).toBe(new Date(onAt).toISOString());
  });

  // 3 — multiple outages + 21 longest + 22 last outage/recovery
  it('3/21/22. multiple outages -> count, longest, last outage & recovery', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 12 * HOUR;

    const { service } = buildService({
      operational: operational('ONLINE'),
      anchor: evt(start - HOUR, 'ONLINE'),
      events: [
        evt(start + 1 * HOUR, 'OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
        evt(start + 1.5 * HOUR, 'ONLINE'),
        evt(start + 5 * HOUR, 'OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
        evt(start + 8 * HOUR, 'ONLINE'),
      ],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.outages.count).toBe(2);
    expect(result.outages.longestSeconds).toBe(3 * 3600);
    expect(result.outages.totalDowntimeSeconds).toBe(3.5 * 3600);
    expect(result.outages.lastOutageAt).toBe(
      new Date(start + 5 * HOUR).toISOString(),
    );
    expect(result.outages.lastRecoveryAt).toBe(
      new Date(start + 8 * HOUR).toISOString(),
    );
    expect(result.availability.percentage).toBeCloseTo(
      (8.5 / 12) * 100,
      4,
    );
  });

  // 4 — outage starts before the window
  it('4. outage started before the window -> clipped start, in-window duration', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 6 * HOUR;
    const actualOff = start - 2 * HOUR;
    const onAt = start + 1 * HOUR;

    const { service } = buildService({
      operational: operational('ONLINE'),
      anchor: evt(actualOff, 'OFFLINE', {
        reasons: ['RECORDER_VERIFIED_OFFLINE'],
        monitoringSource: 'RECORDER_OBSERVED',
        observerDeviceName: 'NVR Speco',
        channelNumber: 1,
      }),
      events: [evt(onAt, 'ONLINE')],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.outages.count).toBe(1);
    const [interval] = result.intervals;
    expect(interval.clipped.start).toBe(true);
    expect(interval.startedAt).toBe(new Date(start).toISOString());
    expect(interval.actualStartedAt).toBe(new Date(actualOff).toISOString());
    expect(interval.durationSeconds).toBe(3600);
    expect(interval.actualDurationSeconds).toBe(3 * 3600);
    expect(interval.observerDeviceName).toBe('NVR Speco');
    expect(interval.channelNumber).toBe(1);
    expect(result.availability.downtimeSeconds).toBe(3600);
  });

  // 5 — outage ends after the window (historical `to`)
  it('5. outage still ongoing at a historical `to` -> clipped end, not open', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 6 * HOUR;
    const offAt = start + 4 * HOUR;

    const { service } = buildService({
      operational: operational('OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
      anchor: evt(start - HOUR, 'ONLINE'),
      events: [evt(offAt, 'OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] })],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    const [interval] = result.intervals;
    expect(interval.clipped.end).toBe(true);
    expect(interval.open).toBe(false);
    expect(interval.endedAt).toBeNull();
    expect(interval.durationSeconds).toBe(2 * 3600);
    expect(result.period.clampedToNow).toBe(false);
  });

  // 6 — outage open until now + 23 current.outageOpen
  it('6/23. outage open through "now" -> open interval + current.outageOpen', async () => {
    const { now, query } = nowWindow(6);
    const offAt = now - 2 * HOUR;

    const { service } = buildService({
      operational: operational('OFFLINE', {
        reasons: ['HEARTBEAT_OVERDUE'],
      }),
      anchor: evt(now - 7 * HOUR, 'ONLINE'),
      events: [
        evt(offAt, 'OFFLINE', {
          previousState: 'ONLINE',
          reasons: ['HEARTBEAT_OVERDUE'],
          lastHeartbeatAtMs: offAt - 60 * 1000,
        }),
      ],
    });

    const result = await service.getAvailability('dev-1', 'org-1', query);

    expect(result.period.clampedToNow).toBe(true);
    expect(result.current.outageOpen).toBe(true);
    expect(result.current.outageStartedAt).toBe(new Date(offAt).toISOString());
    expect(result.current.outageStartedWithinWindow).toBe(true);
    expect(result.current.reasonCodes).toEqual(['HEARTBEAT_OVERDUE']);

    const open = result.outages.openOutage;
    expect(open).not.toBeNull();
    expect(open?.open).toBe(true);
    expect(open?.endedAt).toBeNull();
    expect(Math.abs((open?.durationSeconds ?? 0) - 2 * 3600)).toBeLessThanOrEqual(2);
  });

  // 7 — zero events, no anchor
  it('7. zero events and no anchor -> NO_HISTORY, percentage null', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 5 * HOUR;

    const { service } = buildService({
      operational: operational('NEVER_SEEN'),
      anchor: null,
      events: [],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.availability.percentage).toBeNull();
    expect(result.availability.unavailableReason).toBe('NO_HISTORY');
    expect(result.availability.noDataSeconds).toBe(5 * 3600);
    expect(result.availability.confirmedObservedSeconds).toBe(0);
    expect(result.outages.count).toBe(0);
  });

  // 8 — NEVER_SEEN then first observation
  it('8. NEVER_SEEN anchor then goes ONLINE -> neverSeen excluded from denominator', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 4 * HOUR;
    const seenAt = start + 1 * HOUR;

    const { service } = buildService({
      operational: operational('ONLINE'),
      anchor: evt(start - HOUR, 'NEVER_SEEN', {
        alias: 'NEVER_SEEN',
        reasons: ['NO_TELEMETRY'],
      }),
      events: [evt(seenAt, 'ONLINE', { previousState: 'NEVER_SEEN' })],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.availability.neverSeenSeconds).toBe(3600);
    expect(result.availability.uptimeSeconds).toBe(3 * 3600);
    expect(result.availability.downtimeSeconds).toBe(0);
    // gap in coverage -> no period-level figure
    expect(result.availability.percentage).toBeNull();
    expect(result.availability.unavailableReason).toBe('INCOMPLETE_COVERAGE');
    expect(result.availability.confirmedAvailabilityPercentage).toBe(100);
    expect(result.availability.coveragePercentage).toBeCloseTo(75, 4);
    expect(result.outages.count).toBe(0);
  });

  // 9 / 10 — UNKNOWN in the period, never counted as uptime
  it('9/10. UNKNOWN in the period is excluded, never folded into uptime', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 8 * HOUR;

    const { service } = buildService({
      operational: operational('ONLINE'),
      anchor: evt(start - HOUR, 'ONLINE'),
      events: [
        evt(start + 2 * HOUR, 'UNKNOWN', {
          alias: 'UNKNOWN',
          reasons: ['STALE_OBSERVATION'],
        }),
        evt(start + 4 * HOUR, 'ONLINE'),
      ],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.availability.unknownSeconds).toBe(2 * 3600);
    expect(result.availability.uptimeSeconds).toBe(6 * 3600);
    expect(result.availability.downtimeSeconds).toBe(0);
    // 100% available over confirmed time, but the period is not fully covered.
    expect(result.availability.percentage).toBeNull();
    expect(result.availability.unavailableReason).toBe('INCOMPLETE_COVERAGE');
    expect(result.availability.confirmedAvailabilityPercentage).toBe(100);
    expect(result.availability.coveragePercentage).toBeCloseTo(75, 4);
    expect(result.outages.count).toBe(0);
  });

  // 11 — collection PARTIAL never creates downtime (link stays ONLINE)
  it('11. a PARTIAL collection snapshot never produces an outage', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 4 * HOUR;

    const { service } = buildService({
      operational: {
        ...operational('ONLINE'),
        collection: {
          state: 'PARTIAL',
          issues: [{ code: 'OPTIONAL_ENRICHMENT_UNAVAILABLE' }],
        },
      },
      anchor: evt(start - HOUR, 'ONLINE'),
      events: [],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.outages.count).toBe(0);
    expect(result.availability.downtimeSeconds).toBe(0);
    expect(result.availability.percentage).toBe(100);
  });

  // 12 — legacy DEGRADED alias (health) is uptime, never downtime
  it('12. a DEGRADED alias transition is uptime, not downtime', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 6 * HOUR;

    const { service } = buildService({
      operational: operational('ONLINE'),
      anchor: evt(start - HOUR, 'ONLINE'),
      events: [
        // health degradation: alias flips to DEGRADED, link stays ONLINE
        evt(start + 2 * HOUR, 'ONLINE', {
          alias: 'DEGRADED',
          linkStateInContext: 'ONLINE',
          reasons: ['HIGH_TEMPERATURE'],
        }),
        evt(start + 3 * HOUR, 'ONLINE', { alias: 'ONLINE' }),
      ],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.outages.count).toBe(0);
    expect(result.availability.downtimeSeconds).toBe(0);
    expect(result.availability.uptimeSeconds).toBe(6 * 3600);
    expect(result.availability.percentage).toBe(100);
  });

  // 12b — even if context.linkState is missing, DEGRADED alias -> ONLINE
  it('12b. DEGRADED alias without context.linkState still derives link ONLINE', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 4 * HOUR;

    const { service } = buildService({
      operational: operational('ONLINE'),
      anchor: evt(start - HOUR, 'ONLINE', { linkStateInContext: false }),
      events: [
        evt(start + 1 * HOUR, 'ONLINE', {
          alias: 'DEGRADED',
          linkStateInContext: false,
          reasons: ['HIGH_STORAGE_USAGE'],
        }),
      ],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.outages.count).toBe(0);
    expect(result.availability.downtimeSeconds).toBe(0);
  });

  // 13 — recorder-verified child OFFLINE counts as child downtime
  it('13. recorder-verified child OFFLINE is a real outage with recorder evidence', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 4 * HOUR;
    const offAt = start + 1 * HOUR;
    const onAt = start + 2 * HOUR;

    const { service } = buildService({
      device: device({
        deviceType: 'CAMERA',
        monitoringMode: 'VIA_GATEWAY',
        gatewayDeviceId: 'nvr-1',
      }),
      operational: operational('ONLINE', {
        source: 'RECORDER_OBSERVED',
        verification: 'RECORDER_VERIFIED',
        observerDeviceId: 'nvr-1',
      }),
      anchor: evt(start - HOUR, 'ONLINE', {
        monitoringSource: 'RECORDER_OBSERVED',
        individualVerification: 'RECORDER_VERIFIED',
      }),
      events: [
        evt(offAt, 'OFFLINE', {
          reasons: ['REPORTED_OFFLINE', 'RECORDER_VERIFIED_OFFLINE'],
          monitoringSource: 'RECORDER_OBSERVED',
          individualVerification: 'RECORDER_VERIFIED',
          observerDeviceId: 'nvr-1',
          observerDeviceName: 'NVR Speco',
          channelNumber: 1,
          ageSeconds: 0,
        }),
        evt(onAt, 'ONLINE', { monitoringSource: 'RECORDER_OBSERVED' }),
      ],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.outages.count).toBe(1);
    const [interval] = result.intervals;
    expect(interval.durationSeconds).toBe(3600);
    expect(interval.monitoringSource).toBe('RECORDER_OBSERVED');
    expect(interval.individualVerification).toBe('RECORDER_VERIFIED');
    expect(interval.observerDeviceName).toBe('NVR Speco');
    expect(interval.channelNumber).toBe(1);
    expect(interval.reasonCodes).toEqual([
      'REPORTED_OFFLINE',
      'RECORDER_VERIFIED_OFFLINE',
    ]);
    expect(interval.detectionLatencySeconds).toBe(0);
  });

  // 15 — recovery closes exactly the matching outage
  it('15/16. ONLINE→OFFLINE→OFFLINE(reason change)→ONLINE is one merged outage', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 6 * HOUR;

    const { service } = buildService({
      operational: operational('ONLINE'),
      anchor: evt(start - HOUR, 'ONLINE'),
      events: [
        evt(start + 1 * HOUR, 'OFFLINE', { reasons: ['REPORTED_OFFLINE'] }),
        // still OFFLINE, reason escalates — must NOT open a second interval
        evt(start + 2 * HOUR, 'OFFLINE', {
          reasons: ['HEARTBEAT_OVERDUE'],
          previousState: 'OFFLINE',
        }),
        evt(start + 3 * HOUR, 'ONLINE'),
      ],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.outages.count).toBe(1);
    expect(result.intervals[0].durationSeconds).toBe(2 * 3600);
    expect(result.intervals[0].reasonCodes).toEqual(['REPORTED_OFFLINE']);
  });

  // 16 — repeated same-state polling produces no extra interval
  it('16. repeated identical OFFLINE events do not create duplicate outages', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 6 * HOUR;
    const offAt = start + 1 * HOUR;

    const { service } = buildService({
      operational: operational('OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
      anchor: evt(start - HOUR, 'ONLINE'),
      events: [
        evt(offAt, 'OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
        evt(offAt + 30 * 60 * 1000, 'OFFLINE', {
          reasons: ['HEARTBEAT_OVERDUE'],
          previousState: 'OFFLINE',
        }),
        evt(offAt + 60 * 60 * 1000, 'OFFLINE', {
          reasons: ['HEARTBEAT_OVERDUE'],
          previousState: 'OFFLINE',
        }),
      ],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.outages.count).toBe(1);
  });

  // 20 — availability math is uptime / (uptime + downtime)
  it('20. availability math excludes UNKNOWN/NEVER_SEEN/NO_DATA from the denominator', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 10 * HOUR;

    const { service } = buildService({
      operational: operational('ONLINE'),
      // no anchor -> first 2h are NO_DATA
      anchor: null,
      events: [
        evt(start + 2 * HOUR, 'ONLINE', {
          eventType: 'INITIAL_STATE',
          previousState: null,
        }),
        evt(start + 5 * HOUR, 'OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
        evt(start + 6 * HOUR, 'UNKNOWN', {
          alias: 'UNKNOWN',
          reasons: ['STALE_OBSERVATION'],
        }),
        evt(start + 7 * HOUR, 'ONLINE'),
      ],
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    // uptime = 3h (2->5) + 3h (7->10) = 6h; downtime = 1h; unknown = 1h; nodata = 2h
    expect(result.availability.uptimeSeconds).toBe(6 * 3600);
    expect(result.availability.downtimeSeconds).toBe(3600);
    expect(result.availability.unknownSeconds).toBe(3600);
    expect(result.availability.noDataSeconds).toBe(2 * 3600);
    expect(result.availability.confirmedObservedSeconds).toBe(7 * 3600);
    // period is not fully covered -> percentage null, confirmed figure available
    expect(result.availability.percentage).toBeNull();
    expect(result.availability.unavailableReason).toBe('INCOMPLETE_COVERAGE');
    expect(result.availability.confirmedAvailabilityPercentage).toBeCloseTo(
      (6 / 7) * 100,
      4,
    );
    expect(result.availability.coveragePercentage).toBeCloseTo(70, 4);
  });

  // 24 — read-only: no write method is ever touched
  it('24. never calls anything but read methods on its dependencies', async () => {
    const { service, deviceRepository, connectivityEventsService } =
      buildService({
        operational: operational('ONLINE'),
        anchor: evt(Date.now() - 5 * HOUR, 'ONLINE'),
      });

    await service.getAvailability('dev-1', 'org-1', {});

    expect(deviceRepository.findByIdWithSite).toHaveBeenCalledTimes(1);
    expect(connectivityEventsService.collectEventWindow).toHaveBeenCalledTimes(
      1,
    );
  });

  it('flags a truncated event page in limitations', async () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 5 * HOUR;

    const { service } = buildService({
      operational: operational('ONLINE'),
      anchor: evt(start - HOUR, 'ONLINE'),
      events: [evt(start + HOUR, 'ONLINE')],
      truncated: true,
    });

    const result = await service.getAvailability('dev-1', 'org-1', {
      ...pastWindow(start, end),
    });

    expect(result.coverage.truncated).toBe(true);
    expect(
      result.limitations.some((line) => line.includes('page cap')),
    ).toBe(true);
  });

  it('reconciles a stale event tail when the Health Engine already shows recovery', async () => {
    const { now, query } = nowWindow(4);
    const offAt = now - 2 * HOUR;

    const { service } = buildService({
      // Health Engine says ONLINE now, but the last recorded transition is OFFLINE
      operational: operational('ONLINE'),
      anchor: evt(now - 5 * HOUR, 'ONLINE'),
      events: [evt(offAt, 'OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] })],
    });

    const result = await service.getAvailability('dev-1', 'org-1', query);

    expect(result.current.outageOpen).toBe(false);
    const [interval] = result.intervals;
    expect(interval.open).toBe(false);
    expect(interval.clipped.end).toBe(true);
    expect(interval.endedAt).not.toBeNull();
    // the Health Engine shows ONLINE -> this is a confirmed recovery
    expect(interval.endedByState).toBe('ONLINE');
    expect(interval.recoveryConfirmed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Fix 1 — availability.percentage is period-level, never over a sliver
  // -----------------------------------------------------------------------
  describe('period-level availability semantics', () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 10 * HOUR;

    it('full coverage + all ONLINE -> percentage 100', async () => {
      const { service } = buildService({
        operational: operational('ONLINE'),
        anchor: evt(start - HOUR, 'ONLINE'),
        events: [],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(start, end),
      });

      expect(result.availability.percentage).toBe(100);
      expect(result.availability.confirmedAvailabilityPercentage).toBe(100);
      expect(result.availability.unavailableReason).toBeNull();
      expect(result.availability.coveragePercentage).toBe(100);
    });

    it('full coverage + an outage -> exact period percentage', async () => {
      const { service } = buildService({
        operational: operational('ONLINE'),
        anchor: evt(start - HOUR, 'ONLINE'),
        events: [
          evt(start + 4 * HOUR, 'OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
          evt(start + 5 * HOUR, 'ONLINE'),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(start, end),
      });

      expect(result.availability.percentage).toBe(90);
      expect(result.availability.confirmedAvailabilityPercentage).toBe(90);
      expect(result.availability.unavailableReason).toBeNull();
    });

    it('5% coverage, all-ONLINE in that 5% -> percentage null, confirmed 100', async () => {
      const { service } = buildService({
        operational: operational('ONLINE'),
        anchor: null, // no history before the window
        events: [
          // one 30-minute ONLINE island near the end of a 10h window
          evt(end - 40 * 60 * 1000, 'ONLINE', {
            eventType: 'INITIAL_STATE',
            previousState: null,
          }),
          evt(end - 10 * 60 * 1000, 'UNKNOWN', {
            alias: 'UNKNOWN',
            reasons: ['STALE_OBSERVATION'],
          }),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(start, end),
      });

      expect(result.availability.percentage).toBeNull();
      expect(result.availability.unavailableReason).toBe('INCOMPLETE_COVERAGE');
      expect(result.availability.confirmedAvailabilityPercentage).toBe(100);
      expect(result.availability.uptimeSeconds).toBe(30 * 60);
      expect(result.availability.coveragePercentage).toBeLessThan(10);
    });

    it('partial UNKNOWN -> percentage null', async () => {
      const { service } = buildService({
        operational: operational('ONLINE'),
        anchor: evt(start - HOUR, 'ONLINE'),
        events: [
          evt(start + 3 * HOUR, 'UNKNOWN', {
            alias: 'UNKNOWN',
            reasons: ['STALE_OBSERVATION'],
          }),
          evt(start + 4 * HOUR, 'ONLINE'),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(start, end),
      });

      expect(result.availability.percentage).toBeNull();
      expect(result.availability.unavailableReason).toBe('INCOMPLETE_COVERAGE');
      expect(result.availability.confirmedAvailabilityPercentage).toBe(100);
    });

    it('partial NO_DATA -> percentage null', async () => {
      const { service } = buildService({
        operational: operational('ONLINE'),
        anchor: null,
        events: [
          evt(start + 2 * HOUR, 'ONLINE', {
            eventType: 'INITIAL_STATE',
            previousState: null,
          }),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(start, end),
      });

      expect(result.availability.percentage).toBeNull();
      expect(result.availability.unavailableReason).toBe('INCOMPLETE_COVERAGE');
      expect(result.availability.noDataSeconds).toBe(2 * 3600);
      expect(result.availability.confirmedAvailabilityPercentage).toBe(100);
    });

    it('partial NEVER_SEEN -> percentage null', async () => {
      const { service } = buildService({
        operational: operational('ONLINE'),
        anchor: evt(start - HOUR, 'NEVER_SEEN', {
          alias: 'NEVER_SEEN',
          reasons: ['NO_TELEMETRY'],
        }),
        events: [
          evt(start + 2 * HOUR, 'ONLINE', { previousState: 'NEVER_SEEN' }),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(start, end),
      });

      expect(result.availability.percentage).toBeNull();
      expect(result.availability.unavailableReason).toBe('INCOMPLETE_COVERAGE');
      expect(result.availability.neverSeenSeconds).toBe(2 * 3600);
      expect(result.availability.confirmedAvailabilityPercentage).toBe(100);
    });

    it('zero confirmed time -> both percentages null', async () => {
      const { service } = buildService({
        operational: operational('UNKNOWN'),
        anchor: evt(start - HOUR, 'UNKNOWN', {
          alias: 'UNKNOWN',
          reasons: ['STALE_OBSERVATION'],
        }),
        events: [],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(start, end),
      });

      expect(result.availability.percentage).toBeNull();
      expect(result.availability.confirmedAvailabilityPercentage).toBeNull();
      expect(result.availability.unavailableReason).toBe(
        'NO_CONFIRMED_OBSERVATION',
      );
      expect(result.availability.unknownSeconds).toBe(10 * 3600);
    });
  });

  // -----------------------------------------------------------------------
  // Fix 2 — UNKNOWN / NEVER_SEEN is not a recovery
  // -----------------------------------------------------------------------
  describe('recovery is only OFFLINE -> ONLINE', () => {
    const end = Date.UTC(2026, 7, 20, 12, 0, 0);
    const start = end - 10 * HOUR;

    it('OFFLINE -> ONLINE is a confirmed recovery', async () => {
      const { service } = buildService({
        operational: operational('ONLINE'),
        anchor: evt(start - HOUR, 'ONLINE'),
        events: [
          evt(start + 2 * HOUR, 'OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
          evt(start + 3 * HOUR, 'ONLINE', { reasons: ['HEARTBEAT_RECOVERED'] }),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(start, end),
      });

      const [interval] = result.intervals;
      expect(interval.endedByState).toBe('ONLINE');
      expect(interval.recoveryConfirmed).toBe(true);
      expect(interval.recoveryReasonCodes).toEqual(['HEARTBEAT_RECOVERED']);
      expect(result.outages.lastRecoveryAt).toBe(
        new Date(start + 3 * HOUR).toISOString(),
      );
      expect(result.availability.downtimeSeconds).toBe(3600);
    });

    it('OFFLINE -> UNKNOWN ends confirmed downtime but is not a recovery', async () => {
      const { service } = buildService({
        operational: operational('UNKNOWN'),
        anchor: evt(start - HOUR, 'ONLINE'),
        events: [
          evt(start + 2 * HOUR, 'OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
          evt(start + 3 * HOUR, 'UNKNOWN', {
            alias: 'UNKNOWN',
            reasons: ['STALE_OBSERVATION'],
          }),
          evt(start + 5 * HOUR, 'ONLINE'),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(start, end),
      });

      const offline = result.intervals[0];
      expect(offline.durationSeconds).toBe(3600); // 2h..3h only
      expect(offline.endedByState).toBe('UNKNOWN');
      expect(offline.recoveryConfirmed).toBe(false);
      expect(offline.recoveryReasonCodes).toBeNull();
      expect(offline.endedAt).toBe(new Date(start + 3 * HOUR).toISOString());
      // the later OFFLINE->...->ONLINE happened via UNKNOWN, so the only
      // confirmed recovery is... none in this window
      expect(
        result.intervals.every((i) => i.recoveryConfirmed === false),
      ).toBe(true);
      expect(result.outages.lastRecoveryAt).toBeNull();
      expect(result.availability.downtimeSeconds).toBe(3600);
      expect(result.availability.unknownSeconds).toBe(2 * 3600);
    });

    it('OFFLINE -> NEVER_SEEN is not a recovery', async () => {
      const { service } = buildService({
        operational: operational('NEVER_SEEN'),
        anchor: evt(start - HOUR, 'ONLINE'),
        events: [
          evt(start + 2 * HOUR, 'OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
          evt(start + 4 * HOUR, 'NEVER_SEEN', {
            alias: 'NEVER_SEEN',
            reasons: ['NO_TELEMETRY'],
          }),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(start, end),
      });

      const [interval] = result.intervals;
      expect(interval.endedByState).toBe('NEVER_SEEN');
      expect(interval.recoveryConfirmed).toBe(false);
      expect(result.outages.lastRecoveryAt).toBeNull();
      expect(interval.durationSeconds).toBe(2 * 3600);
    });

    it('UNKNOWN -> ONLINE never invents a preceding outage', async () => {
      const { service } = buildService({
        operational: operational('ONLINE'),
        anchor: evt(start - HOUR, 'UNKNOWN', {
          alias: 'UNKNOWN',
          reasons: ['STALE_OBSERVATION'],
        }),
        events: [evt(start + 3 * HOUR, 'ONLINE')],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(start, end),
      });

      expect(result.outages.count).toBe(0);
      expect(result.availability.downtimeSeconds).toBe(0);
      expect(result.availability.unknownSeconds).toBe(3 * 3600);
      expect(result.outages.lastRecoveryAt).toBeNull();
    });

    it('lastRecoveryAt considers only ONLINE recoveries across several outages', async () => {
      const { service } = buildService({
        operational: operational('ONLINE'),
        anchor: evt(start - HOUR, 'ONLINE'),
        events: [
          evt(start + 1 * HOUR, 'OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
          evt(start + 2 * HOUR, 'ONLINE'), // confirmed recovery #1
          evt(start + 5 * HOUR, 'OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
          evt(start + 6 * HOUR, 'UNKNOWN', {
            alias: 'UNKNOWN',
            reasons: ['STALE_OBSERVATION'],
          }), // NOT a recovery
          evt(start + 7 * HOUR, 'ONLINE'),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(start, end),
      });

      expect(result.outages.count).toBe(2);
      expect(result.outages.longestSeconds).toBe(3600);
      expect(result.availability.downtimeSeconds).toBe(2 * 3600);
      // the most recent outage ended via UNKNOWN, so the last CONFIRMED
      // recovery is still outage #1's
      expect(result.outages.lastRecoveryAt).toBe(
        new Date(start + 2 * HOUR).toISOString(),
      );
      expect(result.intervals[1].recoveryConfirmed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Fix 3 — current.* is the live state, independent of the history window
  // -----------------------------------------------------------------------
  describe('current.* is independent of the requested window', () => {
    const histEnd = Date.UTC(2026, 7, 20, 12, 0, 0);
    const histStart = histEnd - 10 * HOUR;

    it('1. history window ends BEFORE the current outage -> current still reconstructs the start', async () => {
      const offAt = Date.now() - 40 * 60 * 1000; // 40 min ago, long after histEnd

      const { service } = buildService({
        operational: operational('OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
        anchor: evt(histStart - HOUR, 'ONLINE'),
        events: [], // nothing inside the historical window
        recentTransitions: [
          evt(offAt, 'OFFLINE', {
            previousState: 'ONLINE',
            reasons: ['HEARTBEAT_OVERDUE'],
          }),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(histStart, histEnd),
      });

      // historical math is untouched
      expect(result.availability.downtimeSeconds).toBe(0);
      expect(result.availability.percentage).toBe(100);
      expect(result.outages.count).toBe(0);

      // current reflects live state
      expect(result.current.linkState).toBe('OFFLINE');
      expect(result.current.outageOpen).toBe(true);
      expect(result.current.outageStartedAt).toBe(new Date(offAt).toISOString());
      expect(result.current.outageStartedWithinWindow).toBe(false);
      expect(
        result.limitations.some((line) =>
          line.includes('after the end of the requested window'),
        ),
      ).toBe(true);
    });

    it('2. current outage started INSIDE the window -> same start on both sides', async () => {
      const { now, query } = nowWindow(6);
      const offAt = now - 2 * HOUR;

      const { service } = buildService({
        operational: operational('OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
        anchor: evt(now - 7 * HOUR, 'ONLINE'),
        events: [
          evt(offAt, 'OFFLINE', {
            previousState: 'ONLINE',
            reasons: ['HEARTBEAT_OVERDUE'],
            lastHeartbeatAtMs: offAt - 60 * 1000,
          }),
        ],
        recentTransitions: [
          evt(offAt, 'OFFLINE', {
            previousState: 'ONLINE',
            reasons: ['HEARTBEAT_OVERDUE'],
          }),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', query);

      expect(result.current.outageStartedAt).toBe(new Date(offAt).toISOString());
      expect(result.current.outageStartedWithinWindow).toBe(true);
      expect(result.outages.openOutage?.actualStartedAt).toBe(
        new Date(offAt).toISOString(),
      );
    });

    it('3. repeated OFFLINE polls do not move the current outage start', async () => {
      const t1 = Date.now() - 3 * HOUR;
      const t2 = Date.now() - 2 * HOUR;
      const t3 = Date.now() - 1 * HOUR;

      const { service } = buildService({
        operational: operational('OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
        anchor: evt(histStart - HOUR, 'ONLINE'),
        events: [],
        recentTransitions: [
          evt(t1, 'OFFLINE', {
            previousState: 'ONLINE',
            reasons: ['REPORTED_OFFLINE'],
          }),
          evt(t2, 'OFFLINE', {
            previousState: 'OFFLINE',
            reasons: ['HEARTBEAT_OVERDUE'],
          }),
          evt(t3, 'OFFLINE', {
            previousState: 'OFFLINE',
            reasons: ['HEARTBEAT_OVERDUE'],
          }),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(histStart, histEnd),
      });

      expect(result.current.outageStartedAt).toBe(new Date(t1).toISOString());
    });

    it('4. OFFLINE -> ONLINE -> OFFLINE -> current points at the second OFFLINE', async () => {
      const first = Date.now() - 5 * HOUR;
      const recovered = Date.now() - 4 * HOUR;
      const second = Date.now() - 2 * HOUR;

      const { service } = buildService({
        operational: operational('OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
        anchor: evt(histStart - HOUR, 'ONLINE'),
        events: [],
        recentTransitions: [
          evt(first, 'OFFLINE', { previousState: 'ONLINE' }),
          evt(recovered, 'ONLINE', { previousState: 'OFFLINE' }),
          evt(second, 'OFFLINE', {
            previousState: 'ONLINE',
            reasons: ['HEARTBEAT_OVERDUE'],
          }),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(histStart, histEnd),
      });

      expect(result.current.outageStartedAt).toBe(new Date(second).toISOString());
    });

    it('5. Health Engine UNKNOWN -> no open outage, history never consulted', async () => {
      const { service, connectivityEventsService } = buildService({
        operational: operational('UNKNOWN'),
        anchor: evt(histStart - HOUR, 'ONLINE'),
        events: [],
        recentTransitions: [
          evt(Date.now() - HOUR, 'OFFLINE', { previousState: 'ONLINE' }),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(histStart, histEnd),
      });

      expect(result.current.outageOpen).toBe(false);
      expect(result.current.outageStartedAt).toBeNull();
      expect(connectivityEventsService.findRecentTransitions).not.toHaveBeenCalled();
    });

    it('6a. OFFLINE now and recentTransitions=[] -> null + retention-honest limitation, no false claim', async () => {
      const { service } = buildService({
        operational: operational('OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
        anchor: evt(histStart - HOUR, 'ONLINE'),
        events: [],
        recentTransitions: [],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(histStart, histEnd),
      });

      expect(result.current.outageOpen).toBe(true);
      expect(result.current.outageStartedAt).toBeNull();
      expect(
        result.limitations.some((line) =>
          line.includes(
            'could not be reconstructed from retained connectivity history',
          ),
        ),
      ).toBe(true);
      // never claims a transition was proven absent when retention just came back empty
      expect(
        result.limitations.some((line) =>
          line.includes('no connectivity transition has been recorded'),
        ),
      ).toBe(false);
      expect(JSON.stringify(result)).not.toContain(
        'no connectivity transition has been recorded',
      );
    });

    it('6b. OFFLINE now, every retained transition OFFLINE -> HISTORY_INSUFFICIENT', async () => {
      const { service } = buildService({
        operational: operational('OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
        anchor: evt(histStart - HOUR, 'ONLINE'),
        events: [],
        recentTransitions: [
          evt(Date.now() - 2 * HOUR, 'OFFLINE', { previousState: 'OFFLINE' }),
          evt(Date.now() - 3 * HOUR, 'OFFLINE', { previousState: 'OFFLINE' }),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        ...pastWindow(histStart, histEnd),
      });

      expect(result.current.outageStartedAt).toBeNull();
      expect(
        result.limitations.some((line) =>
          line.includes(
            'could not be reconstructed from retained connectivity history',
          ),
        ),
      ).toBe(true);
    });

    it('8. historical outage A open at `to`, recovered after `to`, current outage B later -> current = B, never A', async () => {
      // 10:30 OFFLINE (A) | 11:00 historical `to` | 11:30 ONLINE (recovery A)
      // 14:00 OFFLINE (B) | 15:00 now
      const now = Date.now();
      const aOff = now - 4.5 * HOUR; // 10:30
      const to = now - 4 * HOUR; //     11:00
      const from = now - 8 * HOUR;
      const aOn = now - 3.5 * HOUR; //  11:30
      const bOff = now - 1 * HOUR; //   14:00

      const { service } = buildService({
        operational: operational('OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
        anchor: evt(from - HOUR, 'ONLINE'),
        // the historical window only sees A opening (it is still OFFLINE at `to`)
        events: [
          evt(aOff, 'OFFLINE', {
            previousState: 'ONLINE',
            reasons: ['HEARTBEAT_OVERDUE'],
          }),
        ],
        // live history: A opened, A recovered, B opened
        recentTransitions: [
          evt(aOff, 'OFFLINE', {
            previousState: 'ONLINE',
            reasons: ['HEARTBEAT_OVERDUE'],
          }),
          evt(aOn, 'ONLINE', { previousState: 'OFFLINE' }),
          evt(bOff, 'OFFLINE', {
            previousState: 'ONLINE',
            reasons: ['HEARTBEAT_OVERDUE'],
          }),
        ],
      });

      const result = await service.getAvailability('dev-1', 'org-1', {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      });

      // historical side: outage A is inside the window (clipped at `to`)
      expect(result.outages.count).toBe(1);
      expect(result.intervals[0].actualStartedAt).toBe(
        new Date(aOff).toISOString(),
      );
      expect(result.availability.downtimeSeconds).toBe(
        Math.round((to - aOff) / 1000),
      );

      // current: outage B, NEVER outage A
      expect(result.current.outageOpen).toBe(true);
      expect(result.current.outageStartedAt).toBe(new Date(bOff).toISOString());
      expect(result.current.outageStartedAt).not.toBe(
        new Date(aOff).toISOString(),
      );
      expect(result.current.outageStartedWithinWindow).toBe(false);
    });

    it('7. changing the current-outage lookup never changes the historical math', async () => {
      const offAt = histStart + 4 * HOUR;
      const onAt = histStart + 5 * HOUR;

      // Device is OFFLINE *now*, with a closed outage inside the window and a
      // fresh outage that only exists after `to`.
      const baseConfig = {
        operational: operational('OFFLINE', { reasons: ['HEARTBEAT_OVERDUE'] }),
        anchor: evt(histStart - HOUR, 'ONLINE'),
        events: [
          evt(offAt, 'OFFLINE', {
            previousState: 'ONLINE',
            reasons: ['HEARTBEAT_OVERDUE'],
          }),
          evt(onAt, 'ONLINE', { previousState: 'OFFLINE' }),
        ],
      };

      const runWith = async (recentTransitions: Record<string, unknown>[]) => {
        const { service } = buildService({ ...baseConfig, recentTransitions });
        const result = await service.getAvailability('dev-1', 'org-1', {
          ...pastWindow(histStart, histEnd),
        });
        return {
          availability: result.availability,
          outages: {
            count: result.outages.count,
            totalDowntimeSeconds: result.outages.totalDowntimeSeconds,
            longestSeconds: result.outages.longestSeconds,
            lastRecoveryAt: result.outages.lastRecoveryAt,
          },
          intervals: result.intervals,
          period: result.period,
        };
      };

      const withInWindowOnly = await runWith([
        evt(offAt, 'OFFLINE', {
          previousState: 'ONLINE',
          reasons: ['HEARTBEAT_OVERDUE'],
        }),
        evt(onAt, 'ONLINE', { previousState: 'OFFLINE' }),
      ]);
      const withPostWindowOutage = await runWith([
        evt(offAt, 'OFFLINE', { previousState: 'ONLINE' }),
        evt(onAt, 'ONLINE', { previousState: 'OFFLINE' }),
        evt(Date.now() - HOUR, 'OFFLINE', {
          previousState: 'ONLINE',
          reasons: ['HEARTBEAT_OVERDUE'],
        }),
      ]);

      // The current-outage scan changed the `current` block but not one number
      // in the historical reconstruction.
      expect(withPostWindowOutage).toEqual(withInWindowOnly);
      expect(withPostWindowOutage.availability.downtimeSeconds).toBe(3600);
      expect(withPostWindowOutage.outages.count).toBe(1);
    });
  });
});
