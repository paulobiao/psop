import { NotFoundException } from '@nestjs/common';
import type { ResolvedPeriod } from '../../device/services/device-availability.service.js';
import { ReliabilityPopulationService } from './reliability-population.service.js';
import { SiteReliabilityService } from './site-reliability.service.js';

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

function deviceWithSite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    name: 'Camera 1',
    siteId: 'site-1',
    deviceType: 'CAMERA',
    monitoringMode: 'DIRECT',
    gatewayDeviceId: null,
    status: 'ACTIVE',
    site: { id: 'site-1', code: 'S1', name: 'Site 1', organizationId: 'org-1' },
    ...overrides,
  };
}

function reconstruction(overrides: Record<string, unknown> = {}) {
  return {
    durationSeconds: DAY,
    totals: {
      uptimeSeconds: DAY,
      downtimeSeconds: 0,
      unknownSeconds: 0,
      neverSeenSeconds: 0,
      noDataSeconds: 0,
    },
    confirmedObservedSeconds: DAY,
    hasHistory: true,
    unavailableReason: null,
    confirmedAvailabilityPercentage: 100,
    percentage: 100,
    coveragePercentage: 100,
    intervals: [],
    openOutage: null,
    longest: null,
    lastOutageAt: null,
    lastRecoveryAt: null,
    currentOutageStartMs: null,
    current: {
      linkState: 'ONLINE',
      outageOpen: false,
      outageStartedAt: null,
      outageStartedWithinWindow: null,
      reasonCodes: [],
    },
    currentLinkState: 'ONLINE',
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
    ...overrides,
  };
}

function build(config: {
  site?: unknown;
  observable?: unknown[];
  all?: unknown[];
  reconstructions?: Record<string, unknown>;
}) {
  const siteService = {
    findOne: jest.fn().mockImplementation(() => {
      if (config.site === null) {
        return Promise.reject(new NotFoundException('Site not found'));
      }
      return Promise.resolve(
        config.site === undefined
          ? {
              id: 'site-1',
              code: 'S1',
              name: 'Site 1',
              timezone: 'UTC',
              status: 'ACTIVE',
            }
          : config.site,
      );
    }),
  };

  const deviceService = {
    findAllReliabilityEligibleDevicesWithSite: jest
      .fn()
      .mockResolvedValue(config.observable ?? []),
    findAll: jest.fn().mockResolvedValue(config.all ?? config.observable ?? []),
  };

  const availabilityService = {
    resolveAvailabilityPeriod: jest.fn().mockReturnValue(period()),
    reconstructForResolvedDevice: jest
      .fn()
      .mockImplementation((device: { id: string }) =>
        Promise.resolve(
          (config.reconstructions?.[device.id] as object) ?? reconstruction(),
        ),
      ),
  };

  const populationService = new ReliabilityPopulationService(
    availabilityService as never,
  );

  const service = new SiteReliabilityService(
    siteService as never,
    deviceService as never,
    availabilityService as never,
    populationService,
  );

  return { service, siteService, deviceService, availabilityService };
}

describe('SiteReliabilityService', () => {
  it('22/24. a site outside the caller org is a 404 (no existence leak)', async () => {
    const { service, siteService } = build({ site: null });

    await expect(
      service.getSiteReliability('org-1', 'site-x', {}),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(siteService.findOne).toHaveBeenCalledWith('org-1', 'site-x');
  });

  it('30/31. resolves the period once via the availability parser and reuses it', async () => {
    const { service, availabilityService } = build({
      observable: [deviceWithSite({ id: 'd1' }), deviceWithSite({ id: 'd2' })],
    });

    await service.getSiteReliability('org-1', 'site-1', { window: '7d' });

    expect(availabilityService.resolveAvailabilityPeriod).toHaveBeenCalledTimes(
      1,
    );
    expect(availabilityService.resolveAvailabilityPeriod).toHaveBeenCalledWith(
      { window: '7d' },
      expect.any(Date),
    );
    // same period object handed to every device
    const periods =
      availabilityService.reconstructForResolvedDevice.mock.calls.map(
        (call: unknown[]) => call[1],
      );
    expect(periods).toHaveLength(2);
    expect(periods[0]).toBe(periods[1]);
  });

  it('1/15. all devices online & fully covered -> aggregate percentage is a number', async () => {
    const { service } = build({
      observable: [deviceWithSite({ id: 'd1' }), deviceWithSite({ id: 'd2' })],
    });

    const result = await service.getSiteReliability('org-1', 'site-1', {});

    expect(result.population.eligibleDevices).toBe(2);
    expect(result.current).toEqual({
      online: 2,
      offline: 0,
      unknown: 0,
      neverSeen: 0,
    });
    expect(result.aggregateAvailability.percentage).toBe(100);
    expect(result.aggregateAvailability.unavailableReason).toBeNull();
    expect(result.aggregateAvailability.expectedDeviceSeconds).toBe(2 * DAY);
  });

  it('7. a site with no eligible devices -> percentage null, NO_ELIGIBLE_DEVICES', async () => {
    const { service, availabilityService } = build({ observable: [], all: [] });

    const result = await service.getSiteReliability('org-1', 'site-1', {});

    expect(result.population.eligibleDevices).toBe(0);
    expect(result.aggregateAvailability.percentage).toBeNull();
    expect(result.aggregateAvailability.unavailableReason).toBe(
      'NO_ELIGIBLE_DEVICES',
    );
    expect(
      availabilityService.reconstructForResolvedDevice,
    ).not.toHaveBeenCalled();
  });

  it('8. INVENTORY_ONLY / non-monitored devices are excluded and tallied', async () => {
    const { service } = build({
      observable: [deviceWithSite({ id: 'd1' })],
      all: [
        {
          id: 'd1',
          siteId: 'site-1',
          status: 'ACTIVE',
          monitoringMode: 'DIRECT',
          deviceType: 'CAMERA',
          gatewayDeviceId: null,
        },
        {
          id: 'sensor',
          siteId: 'site-1',
          status: 'ACTIVE',
          monitoringMode: 'INVENTORY_ONLY',
          deviceType: 'SENSOR',
          gatewayDeviceId: null,
        },
        {
          id: 'door',
          siteId: 'site-1',
          status: 'ACTIVE',
          monitoringMode: 'DIRECT',
          deviceType: 'ACCESS_CONTROLLER',
          gatewayDeviceId: null,
        },
      ],
    });

    const result = await service.getSiteReliability('org-1', 'site-1', {});

    expect(result.population.eligibleDevices).toBe(1);
    expect(result.population.excludedDevices).toBe(2);
    expect(result.population.excludedByReason).toEqual({
      INVENTORY_ONLY: 1,
      DEVICE_TYPE_NOT_MONITORED: 1,
    });
  });

  it('status: non-ACTIVE observable devices are excluded, tallied, and never reconstructed; coverage/availability unaffected', async () => {
    const { service, availabilityService } = build({
      // the eligibility query already filters status === ACTIVE
      observable: [deviceWithSite({ id: 'active-cam' })],
      all: [
        {
          id: 'active-cam',
          siteId: 'site-1',
          status: 'ACTIVE',
          monitoringMode: 'DIRECT',
          deviceType: 'CAMERA',
          gatewayDeviceId: null,
        },
        {
          id: 'inactive-cam',
          siteId: 'site-1',
          status: 'INACTIVE',
          monitoringMode: 'DIRECT',
          deviceType: 'CAMERA',
          gatewayDeviceId: null,
        },
        {
          id: 'maint-nvr',
          siteId: 'site-1',
          status: 'MAINTENANCE',
          monitoringMode: 'DIRECT',
          deviceType: 'RECORDER',
          gatewayDeviceId: null,
        },
        {
          id: 'decomm-child',
          siteId: 'site-1',
          status: 'DECOMMISSIONED',
          monitoringMode: 'VIA_GATEWAY',
          deviceType: 'CAMERA',
          gatewayDeviceId: 'maint-nvr',
        },
      ],
    });

    const result = await service.getSiteReliability('org-1', 'site-1', {});

    expect(result.population.eligibleDevices).toBe(1);
    expect(result.population.excludedDevices).toBe(3);
    expect(result.population.excludedByReason).toEqual({
      ADMINISTRATIVE_STATUS_NOT_ACTIVE: 3,
    });

    // only the ACTIVE device was reconstructed
    expect(
      availabilityService.reconstructForResolvedDevice,
    ).toHaveBeenCalledTimes(1);

    // the 3 non-ACTIVE devices never touch the aggregate: 1 device * DAY,
    // fully covered -> a real number, no coverage gap
    expect(result.aggregateAvailability.expectedDeviceSeconds).toBe(DAY);
    expect(result.aggregateAvailability.unknownDeviceSeconds).toBe(0);
    expect(result.aggregateAvailability.coveragePercentage).toBe(100);
    expect(result.aggregateAvailability.percentage).toBe(100);
    expect(result.aggregateAvailability.unavailableReason).toBeNull();
    expect(result.current).toEqual({
      online: 1,
      offline: 0,
      unknown: 0,
      neverSeen: 0,
    });
  });

  it('4. NVR OFFLINE + children UNKNOWN: one outage, no child downtime, percentage null', async () => {
    const { service } = build({
      observable: [
        deviceWithSite({ id: 'nvr', deviceType: 'RECORDER' }),
        deviceWithSite({
          id: 'c1',
          monitoringMode: 'VIA_GATEWAY',
          gatewayDeviceId: 'nvr',
        }),
        deviceWithSite({
          id: 'c2',
          monitoringMode: 'VIA_GATEWAY',
          gatewayDeviceId: 'nvr',
        }),
      ],
      reconstructions: {
        nvr: reconstruction({
          currentLinkState: 'OFFLINE',
          totals: {
            uptimeSeconds: DAY - 7200,
            downtimeSeconds: 7200,
            unknownSeconds: 0,
            neverSeenSeconds: 0,
            noDataSeconds: 0,
          },
          percentage: null,
          unavailableReason: null,
          confirmedAvailabilityPercentage: 75,
          intervals: [
            {
              startedAt: 'x',
              endedAt: null,
              durationSeconds: 7200,
              open: true,
            } as never,
          ],
          longest: {
            startedAt: 'x',
            endedAt: null,
            durationSeconds: 7200,
            open: true,
          } as never,
          lastOutageAt: '2026-08-30T22:00:00.000Z',
        }),
        c1: reconstruction({
          currentLinkState: 'UNKNOWN',
          totals: {
            uptimeSeconds: DAY - 7200,
            downtimeSeconds: 0,
            unknownSeconds: 7200,
            neverSeenSeconds: 0,
            noDataSeconds: 0,
          },
          percentage: null,
          unavailableReason: 'INCOMPLETE_COVERAGE',
        }),
        c2: reconstruction({
          currentLinkState: 'UNKNOWN',
          totals: {
            uptimeSeconds: DAY - 7200,
            downtimeSeconds: 0,
            unknownSeconds: 7200,
            neverSeenSeconds: 0,
            noDataSeconds: 0,
          },
          percentage: null,
          unavailableReason: 'INCOMPLETE_COVERAGE',
        }),
      },
    });

    const result = await service.getSiteReliability('org-1', 'site-1', {});

    expect(result.current).toEqual({
      online: 0,
      offline: 1,
      unknown: 2,
      neverSeen: 0,
    });
    expect(result.outages.total).toBe(1);
    expect(result.outages.devicesAffected).toBe(1);
    expect(result.aggregateAvailability.downtimeDeviceSeconds).toBe(7200);
    expect(result.aggregateAvailability.unknownDeviceSeconds).toBe(14400);
    expect(result.aggregateAvailability.percentage).toBeNull();
    expect(result.aggregateAvailability.unavailableReason).toBe(
      'INCOMPLETE_COVERAGE',
    );
    expect(result.outages.longest?.deviceId).toBe('nvr');
  });

  it('devices rows are ordered by downtime DESC', async () => {
    const { service } = build({
      observable: [
        deviceWithSite({ id: 'a', name: 'Zeta' }),
        deviceWithSite({ id: 'b', name: 'Alpha' }),
      ],
      reconstructions: {
        a: reconstruction({
          totals: {
            uptimeSeconds: DAY,
            downtimeSeconds: 0,
            unknownSeconds: 0,
            neverSeenSeconds: 0,
            noDataSeconds: 0,
          },
        }),
        b: reconstruction({
          totals: {
            uptimeSeconds: DAY - 100,
            downtimeSeconds: 100,
            unknownSeconds: 0,
            neverSeenSeconds: 0,
            noDataSeconds: 0,
          },
        }),
      },
    });

    const result = await service.getSiteReliability('org-1', 'site-1', {});
    expect(result.devices.map((d) => d.name)).toEqual(['Alpha', 'Zeta']);
  });
});
