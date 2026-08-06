import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AlertSeverity,
  AlertStatus,
} from '../../../../generated/prisma/client.js';
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
  constructor(
    private readonly alertRepository: AlertRepository,
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

  async findOne(
    organizationId: string,
    id: string,
  ) {
    const alert = await this.alertRepository.findById(
      id,
      organizationId,
    );

    if (!alert) {
      throw new NotFoundException('Alert not found');
    }

    return alert;
  }

  async resolve(
    organizationId: string,
    id: string,
  ) {
    const alert = await this.findOne(
      organizationId,
      id,
    );

    if (alert.status === 'RESOLVED') {
      return alert;
    }

    return this.alertRepository.resolveById(id);
  }

  async openConnectivityAlert(
    input: ConnectivityAlertInput,
  ) {
    const severity: AlertSeverity =
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

    return this.alertRepository.openConnectivityAlert({
      deviceId: input.deviceId,
      severity,
      title,
      message,
      connectivityState: input.state,
    });
  }

  async resolveConnectivityAlert(
    deviceId: string,
    connectivityState = 'ONLINE',
  ) {
    return this.alertRepository.resolveConnectivityAlert(
      deviceId,
      connectivityState,
    );
  }

  private parseStatus(
    status?: string,
  ): AlertStatus | undefined {
    if (!status) {
      return undefined;
    }

    if (status !== 'OPEN' && status !== 'RESOLVED') {
      throw new BadRequestException(
        'Alert status must be OPEN or RESOLVED',
      );
    }

    return status;
  }
}
