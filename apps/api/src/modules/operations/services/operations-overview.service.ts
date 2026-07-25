import { Injectable } from '@nestjs/common';
import { AlertService } from '../../alert/services/alert.service.js';
import { DeviceConnectivityEventsService } from '../../device/services/device-connectivity-events.service.js';
import { DeviceTelemetryService } from '../../device/services/device-telemetry.service.js';

@Injectable()
export class OperationsOverviewService {
  constructor(
    private readonly telemetryService: DeviceTelemetryService,
    private readonly alertService: AlertService,
    private readonly connectivityEventsService: DeviceConnectivityEventsService,
  ) {}

  async getOverview(organizationId: string) {
    const [fleet, activeAlerts, recentEvents] = await Promise.all([
      this.telemetryService.findFleet(organizationId),
      this.alertService.findActive(organizationId),
      this.connectivityEventsService.findRecent(
        20,
        organizationId,
      ),
    ]);

    const criticalAlerts = activeAlerts.filter(
      (alert) => alert.severity === 'CRITICAL',
    );

    const warningAlerts = activeAlerts.filter(
      (alert) => alert.severity === 'WARNING',
    );

    const siteIds = new Set(fleet.devices.map((item) => item.device.siteId));

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        sites: siteIds.size,
        cameras: fleet.summary.total,
        online: fleet.summary.online,
        offline: fleet.summary.offline,
        neverSeen: fleet.summary.neverSeen,
        unknown: fleet.summary.unknown,
        activeAlerts: activeAlerts.length,
        criticalAlerts: criticalAlerts.length,
        warningAlerts: warningAlerts.length,
      },
      fleet: fleet.devices,
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
    };
  }
}
