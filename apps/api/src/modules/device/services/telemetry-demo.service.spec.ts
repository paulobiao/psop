import { ConfigService } from '@nestjs/config';
import type {
  DeviceRepository,
  DeviceWithSite,
} from '../repositories/device.repository';
import {
  TelemetryDemoService,
} from './telemetry-demo.service';

jest.mock(
  '../repositories/device.repository',
  () => ({
    DeviceRepository:
      class DeviceRepository {},
  }),
);

function createDevice():
DeviceWithSite {
  return {
    id:
      '11111111-1111-4111-8111-111111111111',
    siteId:
      '22222222-2222-4222-8222-222222222222',
    name: 'Demo Camera',
    externalId: 'CAM-DEMO',
    deviceType: 'CAMERA',
    manufacturer: 'PSOP',
    model: 'Demo Model',
    firmwareVersion: '1.0.0',
    ipAddress: null,
    serialNumber: null,
    status: 'ACTIVE',
    expectedHeartbeatInterval: 60,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    site: {
      id:
        '22222222-2222-4222-8222-222222222222',
      organizationId:
        '33333333-3333-4333-8333-333333333333',
      name: 'Demo Site',
      code: 'DEMO',
      timezone: 'UTC',
      address: null,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    },
  } as DeviceWithSite;
}

function createService(
  enabled = true,
) {
  const device =
    createDevice();

  const configService = {
    get: jest.fn(
      () =>
        enabled
          ? 'true'
          : 'false',
    ),
  } as unknown as ConfigService;

  const repository = {
    findByIdWithSite:
      jest.fn()
        .mockResolvedValue(device),
  } as unknown as DeviceRepository;

  return {
    device,
    service:
      new TelemetryDemoService(
        configService,
        repository,
      ),
  };
}

describe(
  'TelemetryDemoService',
  () => {
    it(
      'reports whether demo mode is enabled',
      () => {
        expect(
          createService(true)
            .service
            .getStatus()
            .enabled,
        ).toBe(true);

        expect(
          createService(false)
            .service
            .getStatus()
            .enabled,
        ).toBe(false);
      },
    );

    it(
      'creates healthy online telemetry',
      async () => {
        const {
          service,
          device,
        } = createService();

        await service.setState(
          device.site.organizationId,
          device.id,
          'ONLINE',
        );

        const item =
          service.getItem(device);

        expect(item?.status).toBe(
          'online',
        );

        expect(
          typeof item?.timestamp,
        ).toBe('number');
      },
    );

    it(
      'creates degraded telemetry',
      async () => {
        const {
          service,
          device,
        } = createService();

        await service.setState(
          device.site.organizationId,
          device.id,
          'DEGRADED',
        );

        const item =
          service.getItem(device);

        expect(item?.status).toBe(
          'warning',
        );

        expect(
          Number(item?.temperature_c),
        ).toBeGreaterThanOrEqual(70);

        expect(
          Number(item?.storage_used_pct),
        ).toBeGreaterThanOrEqual(90);
      },
    );

    it(
      'creates an overdue offline heartbeat',
      async () => {
        const {
          service,
          device,
        } = createService();

        await service.setState(
          device.site.organizationId,
          device.id,
          'OFFLINE',
        );

        const item =
          service.getItem(device);

        const age =
          Math.floor(Date.now() / 1000) -
          Number(item?.timestamp);

        expect(age).toBeGreaterThan(
          device
            .expectedHeartbeatInterval *
            2,
        );
      },
    );

    it(
      'removes telemetry for NEVER_SEEN',
      async () => {
        const {
          service,
          device,
        } = createService();

        await service.setState(
          device.site.organizationId,
          device.id,
          'ONLINE',
        );

        await service.setState(
          device.site.organizationId,
          device.id,
          'NEVER_SEEN',
        );

        expect(
          service.getItem(device),
        ).toBeUndefined();
      },
    );
  },
);
