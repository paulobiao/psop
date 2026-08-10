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

interface ConnectivityAlertInput {
  deviceId: string;
  deviceName: string;
  siteCode: string;
  externalId: string;
  state: string;
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

    const title =
      input.state === 'OFFLINE'
        ? `Device ${input.externalId} is offline`
        : input.state === 'DEGRADED'
          ? `Device ${input.externalId} is degraded`
          : `Device ${input.externalId} is not reporting normally`;

    const message =
      `${input.deviceName} at site ${input.siteCode} ` +
      `has connectivity state ${input.state}.`;

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

  async resolveConnectivityAlert(
    deviceId: string,
    connectivityState =
      'ONLINE',
  ) {
    const alert =
      await this.alertRepository
        .resolveConnectivityAlert(
          deviceId,
          connectivityState,
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
