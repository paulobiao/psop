import type { AvailabilityOutageInterval } from '../../device/domain/operational-availability.types.js';
import {
  aggregateAvailability,
  classifyExclusion,
  currentCounts,
  deviceRows,
  deviceUnknownSeconds,
  outageSummary,
  tallyExclusions,
  type DeviceReliabilityInput,
} from './reliability-aggregation.js';

/**
 * Pure device-time aggregation. These cover the arithmetic guarantees of Site &
 * Fleet Reliability V1 without any HTTP / Postgres — the full stack lives in
 * `test/site-fleet-reliability.e2e-spec.ts`.
 */

const HOUR = 3600;

function interval(
  overrides: Partial<AvailabilityOutageInterval> = {},
): AvailabilityOutageInterval {
  return {
    startedAt: '2026-08-31T00:00:00.000Z',
    endedAt: '2026-08-31T01:00:00.000Z',
    durationSeconds: HOUR,
    open: false,
    clipped: { start: false, end: false },
    actualStartedAt: '2026-08-31T00:00:00.000Z',
    actualEndedAt: '2026-08-31T01:00:00.000Z',
    actualDurationSeconds: HOUR,
    detectionLatencySeconds: 0,
    monitoringSource: 'DIRECT',
    individualVerification: 'DIRECT',
    observerDeviceId: null,
    observerDeviceName: null,
    channelNumber: null,
    reasonCodes: [],
    endedByState: 'ONLINE',
    recoveryConfirmed: true,
    recoveryReasonCodes: [],
    ...overrides,
  };
}

function dev(
  overrides: Partial<DeviceReliabilityInput> = {},
): DeviceReliabilityInput {
  const totals = {
    uptimeSeconds: 24 * HOUR,
    downtimeSeconds: 0,
    unknownSeconds: 0,
    neverSeenSeconds: 0,
    noDataSeconds: 0,
    ...(overrides.totals ?? {}),
  };

  return {
    deviceId: overrides.deviceId ?? 'dev-1',
    name: overrides.name ?? 'Camera 1',
    deviceType: overrides.deviceType ?? 'CAMERA',
    monitoringMode: overrides.monitoringMode ?? 'DIRECT',
    siteId: overrides.siteId ?? 'site-1',
    currentLinkState:
      'currentLinkState' in overrides
        ? (overrides.currentLinkState ?? null)
        : 'ONLINE',
    totals,
    confirmedObservedSeconds:
      overrides.confirmedObservedSeconds ??
      totals.uptimeSeconds + totals.downtimeSeconds,
    percentage: overrides.percentage ?? null,
    confirmedAvailabilityPercentage:
      overrides.confirmedAvailabilityPercentage ?? null,
    coveragePercentage: overrides.coveragePercentage ?? 0,
    intervals: overrides.intervals ?? [],
    longest: overrides.longest ?? null,
    lastOutageAt: overrides.lastOutageAt ?? null,
    lastRecoveryAt: overrides.lastRecoveryAt ?? null,
  };
}

const DAY = 24 * HOUR;

describe('reliability-aggregation — aggregateAvailability', () => {
  it('1/15/17/18. all devices fully covered -> percentage is a number', () => {
    const devices = [
      dev({
        deviceId: 'a',
        totals: {
          uptimeSeconds: DAY,
          downtimeSeconds: 0,
          unknownSeconds: 0,
          neverSeenSeconds: 0,
          noDataSeconds: 0,
        },
      }),
      dev({
        deviceId: 'b',
        totals: {
          uptimeSeconds: DAY - HOUR,
          downtimeSeconds: HOUR,
          unknownSeconds: 0,
          neverSeenSeconds: 0,
          noDataSeconds: 0,
        },
      }),
    ];

    const result = aggregateAvailability(devices, DAY);

    expect(result.expectedDeviceSeconds).toBe(2 * DAY);
    expect(result.uptimeDeviceSeconds).toBe(2 * DAY - HOUR);
    expect(result.downtimeDeviceSeconds).toBe(HOUR);
    expect(result.unknownDeviceSeconds).toBe(0);
    expect(result.confirmedDeviceSeconds).toBe(2 * DAY);
    expect(result.coveragePercentage).toBe(100);
    expect(result.confirmedAvailabilityPercentage).toBeCloseTo(
      ((2 * DAY - HOUR) / (2 * DAY)) * 100,
      4,
    );
    expect(result.percentage).toBe(result.confirmedAvailabilityPercentage);
    expect(result.unavailableReason).toBeNull();
  });

  it('5/6/10/16. any UNKNOWN device-seconds -> percentage null, INCOMPLETE_COVERAGE', () => {
    const devices = [
      dev({
        deviceId: 'a',
        totals: {
          uptimeSeconds: DAY,
          downtimeSeconds: 0,
          unknownSeconds: 0,
          neverSeenSeconds: 0,
          noDataSeconds: 0,
        },
      }),
      // 50% NO_DATA
      dev({
        deviceId: 'b',
        totals: {
          uptimeSeconds: DAY / 2,
          downtimeSeconds: 0,
          unknownSeconds: 0,
          neverSeenSeconds: 0,
          noDataSeconds: DAY / 2,
        },
      }),
    ];

    const result = aggregateAvailability(devices, DAY);

    expect(result.unknownDeviceSeconds).toBe(DAY / 2);
    expect(result.confirmedDeviceSeconds).toBe(DAY + DAY / 2);
    expect(result.percentage).toBeNull();
    expect(result.unavailableReason).toBe('INCOMPLETE_COVERAGE');
    // confirmed-only figure still exists
    expect(result.confirmedAvailabilityPercentage).toBe(100);
    expect(result.coveragePercentage).toBe(75);
  });

  it('4. NVR OFFLINE + children UNKNOWN: downtime only on the NVR, no fictitious child downtime, percentage null', () => {
    const nvr = dev({
      deviceId: 'nvr',
      deviceType: 'RECORDER',
      currentLinkState: 'OFFLINE',
      totals: {
        uptimeSeconds: DAY - 2 * HOUR,
        downtimeSeconds: 2 * HOUR,
        unknownSeconds: 0,
        neverSeenSeconds: 0,
        noDataSeconds: 0,
      },
      intervals: [
        interval({
          durationSeconds: 2 * HOUR,
          open: true,
          endedByState: null,
          recoveryConfirmed: false,
        }),
      ],
      longest: interval({
        durationSeconds: 2 * HOUR,
        open: true,
        endedByState: null,
        recoveryConfirmed: false,
      }),
    });
    const children = ['c1', 'c2', 'c3'].map((id) =>
      dev({
        deviceId: id,
        monitoringMode: 'VIA_GATEWAY',
        currentLinkState: 'UNKNOWN',
        // recorder stopped observing -> 2h UNKNOWN, rest ONLINE
        totals: {
          uptimeSeconds: DAY - 2 * HOUR,
          downtimeSeconds: 0,
          unknownSeconds: 2 * HOUR,
          neverSeenSeconds: 0,
          noDataSeconds: 0,
        },
        intervals: [],
      }),
    );

    const result = aggregateAvailability([nvr, ...children], DAY);
    const outages = outageSummary([nvr, ...children]);

    expect(result.downtimeDeviceSeconds).toBe(2 * HOUR); // only the NVR
    expect(result.unknownDeviceSeconds).toBe(6 * HOUR); // 3 children * 2h
    expect(result.percentage).toBeNull();
    expect(result.unavailableReason).toBe('INCOMPLETE_COVERAGE');
    expect(outages.total).toBe(1); // one recorder outage, not four
    expect(outages.devicesAffected).toBe(1);
    expect(outages.totalDowntimeDeviceSeconds).toBe(2 * HOUR);
  });

  it('3. a child camera OFFLINE does not touch the NVR figures', () => {
    const nvr = dev({
      deviceId: 'nvr',
      deviceType: 'RECORDER',
      currentLinkState: 'ONLINE',
      totals: {
        uptimeSeconds: DAY,
        downtimeSeconds: 0,
        unknownSeconds: 0,
        neverSeenSeconds: 0,
        noDataSeconds: 0,
      },
    });
    const child = dev({
      deviceId: 'c1',
      monitoringMode: 'VIA_GATEWAY',
      currentLinkState: 'OFFLINE',
      totals: {
        uptimeSeconds: DAY - HOUR,
        downtimeSeconds: HOUR,
        unknownSeconds: 0,
        neverSeenSeconds: 0,
        noDataSeconds: 0,
      },
      intervals: [interval({ durationSeconds: HOUR })],
      longest: interval({ durationSeconds: HOUR }),
      lastOutageAt: '2026-08-31T00:00:00.000Z',
    });

    const result = aggregateAvailability([nvr, child], DAY);
    const outages = outageSummary([nvr, child]);

    expect(result.downtimeDeviceSeconds).toBe(HOUR);
    expect(result.unknownDeviceSeconds).toBe(0);
    // full coverage -> a real number
    expect(result.percentage).toBeCloseTo(
      ((2 * DAY - HOUR) / (2 * DAY)) * 100,
      4,
    );
    expect(outages.devicesAffected).toBe(1);
    expect(outages.longest?.deviceId).toBe('c1');
  });

  it('7/11/33. no eligible devices -> percentage null (never 100%), NO_ELIGIBLE_DEVICES', () => {
    const result = aggregateAvailability([], DAY);

    expect(result.expectedDeviceSeconds).toBe(0);
    expect(result.percentage).toBeNull();
    expect(result.confirmedAvailabilityPercentage).toBeNull();
    expect(result.coveragePercentage).toBeNull();
    expect(result.unavailableReason).toBe('NO_ELIGIBLE_DEVICES');
  });

  it('25/26. devices with no history / NEVER_SEEN are NO_DATA, never uptime', () => {
    const devices = [
      dev({
        deviceId: 'never',
        currentLinkState: 'NEVER_SEEN',
        totals: {
          uptimeSeconds: 0,
          downtimeSeconds: 0,
          unknownSeconds: 0,
          neverSeenSeconds: 0,
          noDataSeconds: DAY,
        },
      }),
    ];

    const result = aggregateAvailability(devices, DAY);

    expect(result.uptimeDeviceSeconds).toBe(0);
    expect(result.confirmedDeviceSeconds).toBe(0);
    expect(result.unavailableReason).toBe('NO_CONFIRMED_OBSERVATION');
    expect(result.percentage).toBeNull();
    expect(result.confirmedAvailabilityPercentage).toBeNull();
  });

  it('20/21. organization figure uses device-seconds, not a mean of site percentages', () => {
    // Site X: 1 device, 0% available (down the whole day)
    const siteX = [
      dev({
        deviceId: 'x1',
        siteId: 'X',
        totals: {
          uptimeSeconds: 0,
          downtimeSeconds: DAY,
          unknownSeconds: 0,
          neverSeenSeconds: 0,
          noDataSeconds: 0,
        },
      }),
    ];
    // Site Y: 99 devices, 100% available
    const siteY = Array.from({ length: 99 }, (_, i) =>
      dev({
        deviceId: `y${i}`,
        siteId: 'Y',
        totals: {
          uptimeSeconds: DAY,
          downtimeSeconds: 0,
          unknownSeconds: 0,
          neverSeenSeconds: 0,
          noDataSeconds: 0,
        },
      }),
    );

    const orgAggregate = aggregateAvailability([...siteX, ...siteY], DAY);

    // Mean of site percentages would be (0 + 100) / 2 = 50%.
    // Device-seconds: 99*DAY uptime / 100*DAY confirmed = 99%.
    expect(orgAggregate.percentage).toBeCloseTo(99, 4);
    expect(orgAggregate.percentage).not.toBeCloseTo(50, 1);
  });

  it('rounding: a fully-covered population never trips INCOMPLETE_COVERAGE via epsilon', () => {
    const devices = Array.from({ length: 7 }, (_, i) =>
      dev({
        deviceId: `d${i}`,
        totals: {
          uptimeSeconds: 12345,
          downtimeSeconds: 6789,
          unknownSeconds: 0,
          neverSeenSeconds: 0,
          noDataSeconds: 0,
        },
      }),
    );

    const result = aggregateAvailability(devices, 12345 + 6789);

    expect(result.unknownDeviceSeconds).toBe(0);
    expect(result.unavailableReason).toBeNull();
    expect(result.percentage).not.toBeNull();
  });
});

describe('reliability-aggregation — currentCounts', () => {
  it('14/9. counts come straight from the live link state; mixed types', () => {
    const devices = [
      dev({ currentLinkState: 'ONLINE', deviceType: 'CAMERA' }),
      dev({ currentLinkState: 'ONLINE', deviceType: 'RECORDER' }),
      dev({ currentLinkState: 'OFFLINE', deviceType: 'GATEWAY' }),
      dev({ currentLinkState: 'UNKNOWN', deviceType: 'CAMERA' }),
      dev({ currentLinkState: 'NEVER_SEEN', deviceType: 'CAMERA' }),
      dev({ currentLinkState: null, deviceType: 'CAMERA' }),
    ];

    expect(currentCounts(devices)).toEqual({
      online: 2,
      offline: 1,
      unknown: 2, // UNKNOWN + null (never assumed online)
      neverSeen: 1,
    });
  });

  it('27/28. health DEGRADED / collection PARTIAL never reach current (they are not link states)', () => {
    // The aggregation only ever sees LinkState; DEGRADED/PARTIAL cannot appear.
    const devices = [dev({ currentLinkState: 'ONLINE' })];
    expect(currentCounts(devices)).toEqual({
      online: 1,
      offline: 0,
      unknown: 0,
      neverSeen: 0,
    });
  });
});

describe('reliability-aggregation — outageSummary', () => {
  it('10/12/13. longest / devicesAffected / total downtime with no double counting', () => {
    const devices = [
      dev({
        deviceId: 'a',
        totals: {
          uptimeSeconds: DAY - 3 * HOUR,
          downtimeSeconds: 3 * HOUR,
          unknownSeconds: 0,
          neverSeenSeconds: 0,
          noDataSeconds: 0,
        },
        intervals: [
          interval({
            durationSeconds: HOUR,
            startedAt: '2026-08-31T00:00:00.000Z',
          }),
          interval({
            durationSeconds: 2 * HOUR,
            startedAt: '2026-08-31T05:00:00.000Z',
          }),
        ],
        longest: interval({ durationSeconds: 2 * HOUR }),
        lastOutageAt: '2026-08-31T05:00:00.000Z',
        lastRecoveryAt: '2026-08-31T07:00:00.000Z',
      }),
      dev({
        deviceId: 'b',
        totals: {
          uptimeSeconds: DAY - 4 * HOUR,
          downtimeSeconds: 4 * HOUR,
          unknownSeconds: 0,
          neverSeenSeconds: 0,
          noDataSeconds: 0,
        },
        intervals: [
          interval({
            durationSeconds: 4 * HOUR,
            startedAt: '2026-08-31T02:00:00.000Z',
          }),
        ],
        longest: interval({ durationSeconds: 4 * HOUR }),
        lastOutageAt: '2026-08-31T02:00:00.000Z',
        lastRecoveryAt: '2026-08-31T06:00:00.000Z',
      }),
      dev({ deviceId: 'c', intervals: [], longest: null }),
    ];

    const result = outageSummary(devices);

    expect(result.total).toBe(3);
    expect(result.devicesAffected).toBe(2);
    expect(result.totalDowntimeDeviceSeconds).toBe(7 * HOUR);
    expect(result.longest?.deviceId).toBe('b');
    expect(result.longest?.durationSeconds).toBe(4 * HOUR);
    expect(result.lastOutageAt).toBe('2026-08-31T05:00:00.000Z');
    expect(result.lastConfirmedRecoveryAt).toBe('2026-08-31T07:00:00.000Z');
  });

  it('empty population -> zeros and nulls', () => {
    expect(outageSummary([])).toEqual({
      total: 0,
      devicesAffected: 0,
      totalDowntimeDeviceSeconds: 0,
      longest: null,
      lastOutageAt: null,
      lastConfirmedRecoveryAt: null,
    });
  });
});

describe('reliability-aggregation — deviceRows ordering', () => {
  it('8. ordered by downtime DESC then name (ordering, not ranking)', () => {
    const rows = deviceRows([
      dev({
        deviceId: 'a',
        name: 'Zeta',
        totals: {
          uptimeSeconds: DAY,
          downtimeSeconds: 0,
          unknownSeconds: 0,
          neverSeenSeconds: 0,
          noDataSeconds: 0,
        },
      }),
      dev({
        deviceId: 'b',
        name: 'Alpha',
        totals: {
          uptimeSeconds: DAY - HOUR,
          downtimeSeconds: HOUR,
          unknownSeconds: 0,
          neverSeenSeconds: 0,
          noDataSeconds: 0,
        },
      }),
      dev({
        deviceId: 'c',
        name: 'Beta',
        totals: {
          uptimeSeconds: DAY,
          downtimeSeconds: 0,
          unknownSeconds: 0,
          neverSeenSeconds: 0,
          noDataSeconds: 0,
        },
      }),
    ]);

    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Beta', 'Zeta']);
    expect(rows[0].downtimeSeconds).toBe(HOUR);
  });

  it('deviceUnknownSeconds folds unknown + neverSeen + noData', () => {
    expect(
      deviceUnknownSeconds(
        dev({
          totals: {
            uptimeSeconds: 0,
            downtimeSeconds: 0,
            unknownSeconds: 10,
            neverSeenSeconds: 20,
            noDataSeconds: 30,
          },
        }),
      ),
    ).toBe(60);
  });
});

describe('reliability-aggregation — exclusion classification', () => {
  const excl = (
    overrides: Partial<Parameters<typeof classifyExclusion>[0]>,
  ): Parameters<typeof classifyExclusion>[0] => ({
    status: 'ACTIVE',
    monitoringMode: 'DIRECT',
    deviceType: 'CAMERA',
    gatewayDeviceId: null,
    ...overrides,
  });

  it('8. INVENTORY_ONLY / non-camera types are classified, not silently dropped', () => {
    expect(
      classifyExclusion(
        excl({ monitoringMode: 'INVENTORY_ONLY', deviceType: 'SENSOR' }),
      ),
    ).toBe('INVENTORY_ONLY');
    expect(
      classifyExclusion(
        excl({ monitoringMode: 'DIRECT', deviceType: 'ACCESS_CONTROLLER' }),
      ),
    ).toBe('DEVICE_TYPE_NOT_MONITORED');
    expect(
      classifyExclusion(
        excl({
          monitoringMode: 'VIA_GATEWAY',
          deviceType: 'SENSOR',
          gatewayDeviceId: 'g1',
        }),
      ),
    ).toBe('GATEWAY_CHILD_NOT_CAMERA');
    expect(
      classifyExclusion(
        excl({
          monitoringMode: 'VIA_GATEWAY',
          deviceType: 'CAMERA',
          gatewayDeviceId: null,
        }),
      ),
    ).toBe('GATEWAY_CHILD_WITHOUT_RECORDER');
  });

  it('status: a structurally-observable non-ACTIVE device -> ADMINISTRATIVE_STATUS_NOT_ACTIVE', () => {
    for (const status of ['INACTIVE', 'MAINTENANCE', 'DECOMMISSIONED'] as const) {
      expect(
        classifyExclusion(
          excl({ status, monitoringMode: 'DIRECT', deviceType: 'CAMERA' }),
        ),
      ).toBe('ADMINISTRATIVE_STATUS_NOT_ACTIVE');
      expect(
        classifyExclusion(
          excl({
            status,
            monitoringMode: 'VIA_GATEWAY',
            deviceType: 'CAMERA',
            gatewayDeviceId: 'nvr-1',
          }),
        ),
      ).toBe('ADMINISTRATIVE_STATUS_NOT_ACTIVE');
    }
  });

  it('status: structural reasons win over status (a non-ACTIVE sensor is still INVENTORY_ONLY)', () => {
    expect(
      classifyExclusion(
        excl({
          status: 'DECOMMISSIONED',
          monitoringMode: 'INVENTORY_ONLY',
          deviceType: 'SENSOR',
        }),
      ),
    ).toBe('INVENTORY_ONLY');
    expect(
      classifyExclusion(
        excl({
          status: 'INACTIVE',
          monitoringMode: 'DIRECT',
          deviceType: 'NETWORK_SWITCH',
        }),
      ),
    ).toBe('DEVICE_TYPE_NOT_MONITORED');
  });

  it('tallyExclusions counts by reason, folding INACTIVE/MAINTENANCE/DECOMMISSIONED together', () => {
    expect(
      tallyExclusions([
        excl({ monitoringMode: 'INVENTORY_ONLY', deviceType: 'SENSOR' }),
        excl({ monitoringMode: 'INVENTORY_ONLY', deviceType: 'INTERCOM' }),
        excl({ monitoringMode: 'DIRECT', deviceType: 'NETWORK_SWITCH' }),
        excl({ status: 'INACTIVE', deviceType: 'CAMERA' }),
        excl({ status: 'MAINTENANCE', deviceType: 'RECORDER' }),
        excl({ status: 'DECOMMISSIONED', deviceType: 'CAMERA' }),
      ]),
    ).toEqual({
      INVENTORY_ONLY: 2,
      DEVICE_TYPE_NOT_MONITORED: 1,
      ADMINISTRATIVE_STATUS_NOT_ACTIVE: 3,
    });
  });
});
