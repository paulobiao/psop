import { Injectable } from '@nestjs/common';
import { AlertService } from '../../alert/services/alert.service.js';
import { DeviceConnectivityEventsService } from '../../device/services/device-connectivity-events.service.js';
import { DeviceTelemetryService } from '../../device/services/device-telemetry.service.js';
import { DeviceService } from '../../device/services/device.service.js';

@Injectable()
export class OperationsOverviewService {
  constructor(
    private readonly telemetryService: DeviceTelemetryService,
    private readonly deviceService: DeviceService,
    private readonly alertService: AlertService,
    private readonly connectivityEventsService: DeviceConnectivityEventsService,
  ) {}

  async getOverview(organizationId: string) {
    const generatedAt = new Date();

    const [
      fleet,
      inventory,
      activeAlerts,
      recentEvents,
      recentIncidents,
    ] = await Promise.all([
      this.telemetryService.findFleet(organizationId),
      this.deviceService.findAll(organizationId),
      this.alertService.findActive(organizationId),
      this.connectivityEventsService.findRecent(
        20,
        organizationId,
      ),
      this.alertService.findRecentConnectivityIncidents(
        organizationId,
        50,
      ),
    ]);

    const criticalAlerts = activeAlerts.filter(
      (alert) => alert.severity === 'CRITICAL',
    );

    const warningAlerts = activeAlerts.filter(
      (alert) => alert.severity === 'WARNING',
    );

    const siteIds = new Set(
      fleet.devices.map(
        (item) => item.device.siteId,
      ),
    );

    const devicesById = new Map(
      inventory.map((device) => [
        device.id,
        device,
      ]),
    );

    const fleetByDeviceId = new Map(
      fleet.devices.map((item) => [
        item.device.id,
        item,
      ]),
    );

    const gatewayManaged = inventory.flatMap(
      (device) => {
        if (
          device.monitoringMode !== 'VIA_GATEWAY' ||
          !device.gatewayDeviceId
        ) {
          return [];
        }

        const gateway = devicesById.get(
          device.gatewayDeviceId,
        );

        const gatewaySnapshot =
          fleetByDeviceId.get(
            device.gatewayDeviceId,
          );

        if (!gateway || !gatewaySnapshot) {
          return [];
        }

        return [
          {
            device: {
              id: device.id,
              name: device.name,
              externalId:
                device.externalId,
              deviceType:
                device.deviceType,
              administrativeStatus:
                device.status,
              siteId:
                gatewaySnapshot.device.siteId,
              siteCode:
                gatewaySnapshot.device.siteCode,
              siteName:
                gatewaySnapshot.device.siteName,
            },
            monitoring: {
              source:
                'GATEWAY_DERIVED' as const,
              individualVerification:
                'NOT_VERIFIED' as const,
            },
            gateway: {
              id: gateway.id,
              name: gateway.name,
              externalId:
                gateway.externalId,
              deviceType:
                gateway.deviceType,
              connectivity:
                gatewaySnapshot.connectivity,
            },
          },
        ];
      },
    );

    return {
      generatedAt: generatedAt.toISOString(),
      summary: {
        sites: siteIds.size,
        cameras: fleet.summary.total,
        gatewayManaged:
          gatewayManaged.length,
        online: fleet.summary.online,
        degraded: fleet.summary.degraded,
        offline: fleet.summary.offline,
        neverSeen: fleet.summary.neverSeen,
        unknown: fleet.summary.unknown,
        activeAlerts: activeAlerts.length,
        criticalAlerts: criticalAlerts.length,
        warningAlerts: warningAlerts.length,
      },
      fleet: fleet.devices,
      gatewayManaged,
      activeAlerts: activeAlerts.map((alert) => ({
        id: alert.id,
        deviceId: alert.deviceId,
        deviceName: alert.device.name,
        externalId: alert.device.externalId,
        siteCode: alert.device.site.code,
        siteName: alert.device.site.name,
        type: alert.type,
        status: alert.status,
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        connectivityState: alert.connectivityState,
        openedAt: alert.openedAt,
        lastDetectedAt: alert.lastDetectedAt,
      })),
      recentEvents,
      recentIncidents: recentIncidents.map((alert) => {
        const endedAt = alert.resolvedAt;
        const durationEnd = endedAt ?? generatedAt;

        return {
          id: alert.id,
          deviceId: alert.deviceId,
          deviceName: alert.device.name,
          externalId: alert.device.externalId,
          deviceType: alert.device.deviceType,
          siteId: alert.device.site.id,
          siteCode: alert.device.site.code,
          siteName: alert.device.site.name,
          status: alert.status,
          severity: alert.severity,
          title: alert.title,
          message: alert.message,
          terminalConnectivityState:
            alert.connectivityState,
          monitoringSource: 'DIRECT' as const,
          startedAt: alert.openedAt,
          endedAt,
          lastDetectedAt: alert.lastDetectedAt,
          durationSeconds: Math.max(
            0,
            Math.floor(
              (
                durationEnd.getTime() -
                alert.openedAt.getTime()
              ) / 1000,
            ),
          ),
        };
      }),
    };
  }
}
