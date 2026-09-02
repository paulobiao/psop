import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  AlertSeverity,
  AlertStatus,
} from '../../../../generated/prisma/client.js';
import { NotificationService } from '../../notification/services/notification.service.js';
import { AlertRepository } from '../repositories/alert.repository.js';
import type { ConnectivityContext } from '../types/connectivity-context.type.js';

interface ConnectivityAlertInput {
  deviceId: string;
  deviceName: string;
  siteCode: string;
  externalId: string;
  state: string;
  context: ConnectivityContext;
}

@Injectable()
export class AlertService {
  private readonly logger =
    new Logger(
      AlertService.name,
    );

  constructor(
    private readonly alertRepository:
      AlertRepository,
    private readonly notificationService:
      NotificationService,
  ) {}

  async findAll(
    organizationId: string,
    status?: string,
    deviceId?: string,
  ) {
    return this.alertRepository.findAll({
      organizationId,
      status: this.parseStatus(status),
      deviceId,
    });
  }

  async findActive(
    organizationId: string,
    deviceId?: string,
  ) {
    return this.alertRepository.findAll({
      organizationId,
      status: 'OPEN',
      deviceId,
    });
  }

  async findRecentConnectivityIncidents(
    organizationId: string,
    limit = 50,
    deviceId?: string,
  ) {
    return this.alertRepository
      .findRecentConnectivityIncidents({
        organizationId,
        limit,
        deviceId,
      });
  }

  async getConnectivityIncidentAnalytics(
    organizationId: string,
    now = new Date(),
  ) {
    return this.alertRepository
      .getConnectivityIncidentAnalytics(
        organizationId,
        now,
      );
  }

  async findOne(
    organizationId: string,
    id: string,
  ) {
    const alert =
      await this.alertRepository
        .findById(
          id,
          organizationId,
        );

    if (!alert) {
      throw new NotFoundException(
        'Alert not found',
      );
    }

    return alert;
  }

  async resolve(
    organizationId: string,
    id: string,
  ) {
    const alert =
      await this.findOne(
        organizationId,
        id,
      );

    if (
      alert.status ===
      'RESOLVED'
    ) {
      return alert;
    }

    const resolved =
      await this.alertRepository
        .resolveById(id);

    await this.safeNotification(
      () =>
        this.notificationService
          .handleIncidentRecovered(
            resolved,
          ),
    );

    return resolved;
  }

  async openConnectivityAlert(
    input:
      ConnectivityAlertInput,
  ) {
    const severity:
      AlertSeverity =
      input.state === 'OFFLINE'
        ? 'CRITICAL'
        : 'WARNING';

    const { title, message } =
      this.buildIncidentCopy(
        input,
      );

    const alert =
      await this.alertRepository
        .openConnectivityAlert({
          deviceId:
            input.deviceId,
          severity,
          title,
          message,
          connectivityState:
            input.state,
          context:
            input.context,
        });

    await this.safeNotification(
      () =>
        this.notificationService
          .handleIncidentOpened(
            alert,
          ),
    );

    return alert;
  }

  async touchConnectivityAlert(
    deviceId: string,
    context: ConnectivityContext,
  ): Promise<void> {
    await this.alertRepository
      .touchActiveConnectivityAlert(
        deviceId,
        context,
      );
  }

  async resolveConnectivityAlert(
    deviceId: string,
    connectivityState =
      'ONLINE',
    context?: ConnectivityContext,
  ) {
    const alert =
      await this.alertRepository
        .resolveConnectivityAlert(
          deviceId,
          connectivityState,
          context,
        );

    if (alert) {
      await this.safeNotification(
        () =>
          this.notificationService
            .handleIncidentRecovered(
              alert,
            ),
      );
    }

    return alert;
  }

  private buildIncidentCopy(
    input: ConnectivityAlertInput,
  ): { title: string; message: string } {
    const { deviceName, siteCode, state, context } = input;
    const reasons = context.reasons;

    if (reasons.includes('RECORDER_VERIFIED_OFFLINE')) {
      const observerLabel =
        context.observerDeviceName ?? 'its recorder';
      const channelSuffix =
        context.channelNumber !== null
          ? ` on channel ${context.channelNumber}`
          : '';

      return {
        title: `${deviceName} is offline`,
        message: `${deviceName} is offline according to ${observerLabel}${channelSuffix}.`,
      };
    }

    if (reasons.includes('HEARTBEAT_OVERDUE')) {
      return {
        title: `${deviceName} is offline`,
        message: `${deviceName} stopped reporting telemetry.`,
      };
    }

    if (reasons.includes('HIGH_TEMPERATURE')) {
      return {
        title: `${deviceName} is degraded`,
        message: `${deviceName} is degraded because temperature exceeded the configured threshold.`,
      };
    }

    if (reasons.includes('HIGH_STORAGE_USAGE')) {
      return {
        title: `${deviceName} is degraded`,
        message: `${deviceName} is degraded because storage usage exceeded the configured threshold.`,
      };
    }

    const title =
      state === 'OFFLINE'
        ? `${deviceName} is offline`
        : state === 'DEGRADED'
          ? `${deviceName} is degraded`
          : `${deviceName} is not reporting normally`;

    const message =
      `${deviceName} at site ${siteCode} ` +
      `has connectivity state ${state}.`;

    return { title, message };
  }

  private async safeNotification(
    operation:
      () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch {
      this.logger.warn(
        'Incident notification processing failed without interrupting alert state',
      );
    }
  }

  private parseStatus(
    status?: string,
  ): AlertStatus | undefined {
    if (!status) {
      return undefined;
    }

    if (
      status !== 'OPEN' &&
      status !== 'RESOLVED'
    ) {
      throw new BadRequestException(
        'Alert status must be OPEN or RESOLVED',
      );
    }

    return status;
  }
}
