import type { ResolvedPeriod } from '../../device/services/device-availability.service.js';
import { FleetReliabilityService } from './fleet-reliability.service.js';
import { ReliabilityPopulationService } from './reliability-population.service.js';

const DAY = 24 * 3600;

function period(): ResolvedPeriod {
  const to = Date.parse('2026-08-31T00:00:00.000Z');
  return {
    requestedFrom: '2026-08-30T00:00:00.000Z',
    requestedTo: '2026-08-31T00:00:00.000Z',
    fromMs: to - DAY * 1000,
    toMs: to,
    durationSeconds: DAY,
    window: '24h',
    clampedToNow: false,
    endsAtNow: true,
  };
}

function deviceWithSite(
  id: string,
  siteId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: `Device ${id}`,
    siteId,
    deviceType: 'CAMERA',
    monitoringMode: 'DIRECT',
    gatewayDeviceId: null,
    status: 'ACTIVE',
    site: { id: siteId, code: siteId, name: siteId, organizationId: 'org-1' },
    ...overrides,
  };
}

function reconstruction(
  totals: {
    uptimeSeconds: number;
    downtimeSeconds: number;
    unknownSeconds?: number;
    neverSeenSeconds?: number;
    noDataSeconds?: number;
  },
  currentLinkState = 'ONLINE',
) {
  const full = {
    unknownSeconds: 0,
    neverSeenSeconds: 0,
    noDataSeconds: 0,
    ...totals,
  };
  return {
    durationSeconds: DAY,
    totals: full,
    confirmedObservedSeconds: full.uptimeSeconds + full.downtimeSeconds,
    hasHistory: true,
    unavailableReason: null,
    confirmedAvailabilityPercentage: null,
    percentage: null,
    coveragePercentage: 100,
    intervals:
      full.downtimeSeconds > 0
        ? [
            {
              durationSeconds: full.downtimeSeconds,
              startedAt: 'x',
              endedAt: 'y',
              open: false,
            } as never,
          ]
        : [],
    openOutage: null,
    longest:
      full.downtimeSeconds > 0
        ? ({
            durationSeconds: full.downtimeSeconds,
            startedAt: 'x',
            endedAt: 'y',
            open: false,
          } as never)
        : null,
    lastOutageAt: full.downtimeSeconds > 0 ? '2026-08-30T12:00:00.000Z' : null,
    lastRecoveryAt: null,
    currentOutageStartMs: null,
    current: {
      linkState: currentLinkState,
      outageOpen: false,
      outageStartedAt: null,
      outageStartedWithinWindow: null,
      reasonCodes: [],
    },
    currentLinkState,
    observerDeviceName: null,
    monitoring: {
      source: 'DIRECT',
      individualVerification: 'DIRECT',
      observerDeviceId: null,
    },
    coverageMeta: {
      eventCount: 0,
      firstEventAt: null,
      lastEventAt: null,
      hasAnchorBeforeWindow: false,
      truncated: false,
    },
    limitations: [],
  };
}

function build(config: {
  sites: Array<{ id: string; code: string; name: string }>;
  observable: unknown[];
  all?: unknown[];
  reconstructions: Record<string, unknown>;
}) {
  const siteService = {
    findAll: jest.fn().mockResolvedValue(config.sites),
  };
  const deviceService = {
    findAllReliabilityEligibleDevicesWithSite: jest
      .fn()
      .mockResolvedValue(config.observable),
    findAll: jest.fn().mockResolvedValue(config.all ?? config.observable),
  };
  const availabilityService = {
    resolveAvailabilityPeriod: jest.fn().mockReturnValue(period()),
    reconstructForResolvedDevice: jest
      .fn()
      .mockImplementation((device: { id: string }) =>
        Promise.resolve(config.reconstructions[device.id]),
      ),
  };
  const populationService = new ReliabilityPopulationService(
    availabilityService as never,
  );
  const service = new FleetReliabilityService(
    siteService as never,
    deviceService as never,
    availabilityService as never,
    populationService,
  );
  return { service, availabilityService };
}

describe('FleetReliabilityService', () => {
  it('19/20. org aggregate uses device-seconds, NOT the mean of site percentages', async () => {
    // Site X: 1 device fully down. Site Y: 99 devices fully up.
    const observable = [
      deviceWithSite('x1', 'X'),
      ...Array.from({ length: 99 }, (_, i) => deviceWithSite(`y${i}`, 'Y')),
    ];
    const reconstructions: Record<string, unknown> = {
      x1: reconstruction({ uptimeSeconds: 0, downtimeSeconds: DAY }, 'OFFLINE'),
    };
    for (let i = 0; i < 99; i += 1) {
      reconstructions[`y${i}`] = reconstruction({
        uptimeSeconds: DAY,
        downtimeSeconds: 0,
      });
    }

    const { service } = build({
      sites: [
        { id: 'X', code: 'X', name: 'Site X' },
        { id: 'Y', code: 'Y', name: 'Site Y' },
      ],
      observable,
      reconstructions,
    });

    const result = await service.getFleetReliability('org-1', {});

    expect(result.population.sites).toBe(2);
    expect(result.population.eligibleDevices).toBe(100);

    // device-seconds: 99*DAY / 100*DAY = 99%. Mean of site % would be 50%.
    expect(result.aggregateAvailability.percentage).toBeCloseTo(99, 4);

    const siteX = result.sites.find((s) => s.siteId === 'X');
    const siteY = result.sites.find((s) => s.siteId === 'Y');
    expect(siteX?.availabilityPercentage).toBe(0);
    expect(siteY?.availabilityPercentage).toBe(100);
    // sites ordered by downtime DESC -> X first
    expect(result.sites[0].siteId).toBe('X');
  });

  it('23. only devices/sites of the authenticated org are consulted', async () => {
    const { service, availabilityService } = build({
      sites: [{ id: 'A', code: 'A', name: 'Site A' }],
      observable: [deviceWithSite('a1', 'A')],
      reconstructions: {
        a1: reconstruction({ uptimeSeconds: DAY, downtimeSeconds: 0 }),
      },
    });

    await service.getFleetReliability('org-1', {});

    expect(
      (availabilityService.resolveAvailabilityPeriod as jest.Mock).mock.calls,
    ).toHaveLength(1);
  });

  it('7/33. an org with no eligible devices -> percentage null, sites still listed', async () => {
    const { service } = build({
      sites: [
        { id: 'A', code: 'A', name: 'Site A' },
        { id: 'B', code: 'B', name: 'Site B' },
      ],
      observable: [],
      all: [],
      reconstructions: {},
    });

    const result = await service.getFleetReliability('org-1', {});

    expect(result.population.sites).toBe(2);
    expect(result.population.sitesWithEligibleDevices).toBe(0);
    expect(result.population.eligibleDevices).toBe(0);
    expect(result.aggregateAvailability.percentage).toBeNull();
    expect(result.aggregateAvailability.unavailableReason).toBe(
      'NO_ELIGIBLE_DEVICES',
    );
    expect(result.sites).toHaveLength(2);
    expect(result.sites.every((s) => s.availabilityPercentage === null)).toBe(
      true,
    );
  });

  it('status: non-ACTIVE devices are excluded org-wide and never decay the aggregate', async () => {
    const { service, availabilityService } = build({
      sites: [{ id: 'A', code: 'A', name: 'Site A' }],
      // eligibility query already excludes non-ACTIVE
      observable: [deviceWithSite('a1', 'A')],
      all: [
        deviceWithSite('a1', 'A'),
        deviceWithSite('a2', 'A', { status: 'INACTIVE' }),
        deviceWithSite('a3', 'A', { status: 'DECOMMISSIONED' }),
        deviceWithSite('a4', 'A', {
          status: 'MAINTENANCE',
          deviceType: 'RECORDER',
        }),
      ],
      reconstructions: {
        a1: reconstruction({ uptimeSeconds: DAY, downtimeSeconds: 0 }),
      },
    });

    const result = await service.getFleetReliability('org-1', {});

    expect(result.population.eligibleDevices).toBe(1);
    expect(result.population.excludedDevices).toBe(3);
    expect(result.population.excludedByReason).toEqual({
      ADMINISTRATIVE_STATUS_NOT_ACTIVE: 3,
    });
    expect(
      availabilityService.reconstructForResolvedDevice,
    ).toHaveBeenCalledTimes(1);
    expect(result.aggregateAvailability.expectedDeviceSeconds).toBe(DAY);
    expect(result.aggregateAvailability.unknownDeviceSeconds).toBe(0);
    expect(result.aggregateAvailability.percentage).toBe(100);
    expect(result.aggregateAvailability.unavailableReason).toBeNull();
  });

  it('each device is reconstructed exactly once even though it feeds both site and org aggregates', async () => {
    const { service, availabilityService } = build({
      sites: [{ id: 'A', code: 'A', name: 'Site A' }],
      observable: [deviceWithSite('a1', 'A'), deviceWithSite('a2', 'A')],
      reconstructions: {
        a1: reconstruction({ uptimeSeconds: DAY, downtimeSeconds: 0 }),
        a2: reconstruction({ uptimeSeconds: DAY, downtimeSeconds: 0 }),
      },
    });

    await service.getFleetReliability('org-1', {});

    expect(
      availabilityService.reconstructForResolvedDevice,
    ).toHaveBeenCalledTimes(2);
  });
});
