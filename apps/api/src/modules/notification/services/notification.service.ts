import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  AlertSeverity,
  NotificationDelivery,
  NotificationEventType,
  NotificationPolicy,
  UserRole,
} from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { UpdateNotificationPolicyDto } from '../dto/update-notification-policy.dto.js';
import { EmailProviderService } from './email-provider.service.js';

interface IncidentAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  connectivityState: string | null;
  openedAt: Date;
  resolvedAt: Date | null;
  device: {
    id: string;
    name: string;
    externalId: string;
    site: {
      id: string;
      code: string;
      name: string;
      organizationId: string;
    };
  };
}

interface Recipient {
  email: string;
  source: string;
}

@Injectable()
export class NotificationService {
  private readonly logger =
    new Logger(
      NotificationService.name,
    );

  constructor(
    private readonly prisma:
      PrismaService,
    private readonly emailProvider:
      EmailProviderService,
  ) {}

  async getPolicy(
    organizationId: string,
  ) {
    const policy =
      await this.prisma
        .notificationPolicy
        .findUnique({
          where: {
            organizationId,
          },
        });

    return policy ??
      this.defaultPolicy(
        organizationId,
      );
  }

  async updatePolicy(
    organizationId: string,
    input:
      UpdateNotificationPolicyDto,
  ) {
    const existing =
      await this.prisma
        .notificationPolicy
        .findUnique({
          where: {
            organizationId,
          },
        });

    const current =
      existing ??
      this.defaultPolicy(
        organizationId,
      );

    const explicitEmails =
      input.explicitEmails === undefined
        ? current.explicitEmails
        : Array.from(
            new Set(
              input.explicitEmails
                .map((email) =>
                  email
                    .trim()
                    .toLowerCase(),
                )
                .filter(Boolean),
            ),
          ).sort();

    const next = {
      enabled:
        input.enabled ??
        current.enabled,
      minimumSeverity:
        input.minimumSeverity ??
        current.minimumSeverity,
      notifyOnRecovery:
        input.notifyOnRecovery ??
        current.notifyOnRecovery,
      notifyAdmins:
        input.notifyAdmins ??
        current.notifyAdmins,
      notifyOperators:
        input.notifyOperators ??
        current.notifyOperators,
      explicitEmails,
      cooldownMinutes:
        input.cooldownMinutes ??
        current.cooldownMinutes,
      escalationDelayMinutes:
        input.escalationDelayMinutes ??
        current.escalationDelayMinutes,
    };

    if (
      next.enabled &&
      !next.notifyAdmins &&
      !next.notifyOperators &&
      next.explicitEmails.length === 0
    ) {
      throw new BadRequestException(
        'At least one notification recipient is required when notifications are enabled',
      );
    }

    return this.prisma
      .notificationPolicy
      .upsert({
        where: {
          organizationId,
        },
        update: next,
        create: {
          organizationId,
          ...next,
        },
      });
  }

  getTransportStatus() {
    return this.emailProvider
      .getStatus();
  }

  async findDeliveries(
    organizationId: string,
    limit = 100,
  ) {
    const take = Math.min(
      Math.max(limit, 1),
      200,
    );

    const deliveries =
      await this.prisma
        .notificationDelivery
        .findMany({
          where: {
            organizationId,
          },
          include: {
            alert: {
              include: {
                device: {
                  include: {
                    site: true,
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
          take,
        });

    return deliveries.map(
      (delivery) =>
        this.toPublicDelivery(
          delivery,
        ),
    );
  }

  async handleIncidentOpened(
    alert: IncidentAlert,
  ): Promise<void> {
    await this.queueTransition(
      alert,
      'INCIDENT_OPENED',
    );
  }

  async handleIncidentRecovered(
    alert: IncidentAlert,
  ): Promise<void> {
    await this.queueTransition(
      alert,
      'INCIDENT_RECOVERED',
    );
  }

  async processDueForOrganization(
    organizationId: string,
  ) {
    const now = new Date();

    const deliveries =
      await this.prisma
        .notificationDelivery
        .findMany({
          where: {
            organizationId,
            status: {
              in: [
                'PENDING',
                'FAILED',
              ],
            },
            eligibleAt: {
              lte: now,
            },
            attemptCount: {
              lt: 3,
            },
            OR: [
              {
                nextAttemptAt:
                  null,
              },
              {
                nextAttemptAt: {
                  lte: now,
                },
              },
            ],
          },
          include: {
            alert: {
              include: {
                device: {
                  include: {
                    site: true,
                  },
                },
              },
            },
          },
          orderBy: {
            eligibleAt: 'asc',
          },
          take: 50,
        });

    let processed = 0;

    for (const delivery of deliveries) {
      await this.processOne(
        delivery,
      );
      processed += 1;
    }

    return {
      processed,
    };
  }

  async processDueAcrossOrganizations() {
    const now = new Date();

    const organizations =
      await this.prisma
        .notificationDelivery
        .findMany({
          where: {
            status: {
              in: [
                'PENDING',
                'FAILED',
              ],
            },
            eligibleAt: {
              lte: now,
            },
            attemptCount: {
              lt: 3,
            },
            OR: [
              {
                nextAttemptAt:
                  null,
              },
              {
                nextAttemptAt: {
                  lte: now,
                },
              },
            ],
          },
          select: {
            organizationId: true,
          },
          distinct: [
            'organizationId',
          ],
          take: 100,
        });

    for (
      const organization
      of organizations
    ) {
      try {
        await this
          .processDueForOrganization(
            organization
              .organizationId,
          );
      } catch {
        this.logger.warn(
          'Notification worker could not process an organization',
        );
      }
    }
  }

  async retryDelivery(
    organizationId: string,
    deliveryId: string,
  ) {
    const delivery =
      await this.prisma
        .notificationDelivery
        .findFirst({
          where: {
            id: deliveryId,
            organizationId,
          },
        });

    if (!delivery) {
      throw new NotFoundException(
        'Notification delivery not found',
      );
    }

    if (
      ![
        'FAILED',
        'SKIPPED_NOT_CONFIGURED',
      ].includes(delivery.status)
    ) {
      throw new BadRequestException(
        'Only failed or not-configured deliveries can be retried',
      );
    }

    await this.prisma
      .notificationDelivery
      .update({
        where: {
          id: delivery.id,
        },
        data: {
          status: 'PENDING',
          attemptCount: 0,
          lastAttemptAt: null,
          nextAttemptAt: null,
          sentAt: null,
          lastError: null,
          eligibleAt: new Date(),
        },
      });

    await this
      .processDueForOrganization(
        organizationId,
      );

    const refreshed =
      await this.prisma
        .notificationDelivery
        .findFirstOrThrow({
          where: {
            id: delivery.id,
            organizationId,
          },
          include: {
            alert: {
              include: {
                device: {
                  include: {
                    site: true,
                  },
                },
              },
            },
          },
        });

    return this.toPublicDelivery(
      refreshed,
    );
  }

  private async queueTransition(
    alert: IncidentAlert,
    eventType:
      NotificationEventType,
  ): Promise<void> {
    const organizationId =
      alert.device.site
        .organizationId;

    const policy =
      await this.prisma
        .notificationPolicy
        .findUnique({
          where: {
            organizationId,
          },
        });

    if (
      !policy ||
      !policy.enabled ||
      !this.severityAllowed(
        alert.severity,
        policy.minimumSeverity,
      ) ||
      (
        eventType ===
          'INCIDENT_RECOVERED' &&
        !policy.notifyOnRecovery
      )
    ) {
      return;
    }

    const recipients =
      await this.resolveRecipients(
        organizationId,
        policy,
      );

    if (
      recipients.length === 0
    ) {
      return;
    }

    const now = new Date();

    const delayMinutes =
      eventType ===
        'INCIDENT_OPENED'
        ? policy
            .escalationDelayMinutes
        : 0;

    const eligibleAt =
      new Date(
        now.getTime() +
        delayMinutes *
          60 *
          1000,
      );

    const subject =
      this.subjectFor(
        alert,
        eventType,
      );

    const body =
      this.bodyFor(
        alert,
        eventType,
      );

    for (
      const recipient
      of recipients
    ) {
      const dedupKey =
        this.deliveryDedupKey(
          alert.id,
          eventType,
          recipient.email,
        );

      const existing =
        await this.prisma
          .notificationDelivery
          .findUnique({
            where: {
              dedupKey,
            },
          });

      if (existing) {
        continue;
      }

      const cooldown =
        eventType ===
          'INCIDENT_OPENED'
          ? await this
              .isInCooldown(
                organizationId,
                alert.device.id,
                recipient.email,
                policy
                  .cooldownMinutes,
                now,
              )
          : false;

      await this.prisma
        .notificationDelivery
        .create({
          data: {
            organizationId,
            alertId: alert.id,
            eventType,
            channel: 'EMAIL',
            recipientEmail:
              recipient.email,
            recipientSource:
              recipient.source,
            status:
              cooldown
                ? 'SKIPPED_COOLDOWN'
                : 'PENDING',
            dedupKey,
            subject,
            body,
            eligibleAt,
            lastError:
              cooldown
                ? 'Suppressed by notification cooldown'
                : null,
          },
        });
    }

    await this
      .processDueForOrganization(
        organizationId,
      );
  }

  private async processOne(
    delivery:
      NotificationDelivery & {
        alert: IncidentAlert;
      },
  ): Promise<void> {
    const policy =
      await this.prisma
        .notificationPolicy
        .findUnique({
          where: {
            organizationId:
              delivery
                .organizationId,
          },
        });

    if (
      !policy ||
      !policy.enabled ||
      !this.severityAllowed(
        delivery.alert.severity,
        policy.minimumSeverity,
      ) ||
      (
        delivery.eventType ===
          'INCIDENT_RECOVERED' &&
        !policy.notifyOnRecovery
      )
    ) {
      await this.prisma
        .notificationDelivery
        .update({
          where: {
            id: delivery.id,
          },
          data: {
            status:
              'SKIPPED_POLICY',
            lastAttemptAt:
              new Date(),
            nextAttemptAt:
              null,
            lastError:
              'Notification policy no longer permits delivery',
          },
        });
      return;
    }

    const transport =
      this.emailProvider
        .getStatus();

    if (!transport.configured) {
      await this.prisma
        .notificationDelivery
        .update({
          where: {
            id: delivery.id,
          },
          data: {
            status:
              'SKIPPED_NOT_CONFIGURED',
            attemptCount:
              delivery
                .attemptCount +
              1,
            lastAttemptAt:
              new Date(),
            nextAttemptAt:
              null,
            lastError:
              'SMTP transport is not configured',
          },
        });
      return;
    }

    const attemptedAt =
      new Date();

    try {
      await this.emailProvider
        .send({
          to:
            delivery
              .recipientEmail,
          subject:
            delivery.subject,
          text:
            delivery.body,
        });

      await this.prisma
        .notificationDelivery
        .update({
          where: {
            id: delivery.id,
          },
          data: {
            status: 'SENT',
            attemptCount:
              delivery
                .attemptCount +
              1,
            lastAttemptAt:
              attemptedAt,
            nextAttemptAt:
              null,
            sentAt:
              new Date(),
            lastError:
              null,
          },
        });
    } catch {
      const nextAttemptCount =
        delivery
          .attemptCount + 1;

      await this.prisma
        .notificationDelivery
        .update({
          where: {
            id: delivery.id,
          },
          data: {
            status: 'FAILED',
            attemptCount:
              nextAttemptCount,
            lastAttemptAt:
              attemptedAt,
            nextAttemptAt:
              nextAttemptCount < 3
                ? new Date(
                    Date.now() +
                    5 *
                      60 *
                      1000,
                  )
                : null,
            lastError:
              'Email transport failed',
          },
        });
    }
  }

  private async resolveRecipients(
    organizationId: string,
    policy:
      NotificationPolicy,
  ): Promise<Recipient[]> {
    const roles:
      UserRole[] = [];

    if (policy.notifyAdmins) {
      roles.push('ADMIN');
    }

    if (
      policy.notifyOperators
    ) {
      roles.push('OPERATOR');
    }

    const users =
      roles.length > 0
        ? await this.prisma
            .user
            .findMany({
              where: {
                organizationId,
                status: 'ACTIVE',
                deletedAt: null,
                role: {
                  in: roles,
                },
              },
              select: {
                email: true,
                role: true,
              },
            })
        : [];

    const recipients =
      new Map<
        string,
        Recipient
      >();

    for (const user of users) {
      const email =
        user.email
          .trim()
          .toLowerCase();

      recipients.set(
        email,
        {
          email,
          source:
            `ROLE_${user.role}`,
        },
      );
    }

    for (
      const rawEmail
      of policy.explicitEmails
    ) {
      const email =
        rawEmail
          .trim()
          .toLowerCase();

      if (!email) {
        continue;
      }

      if (
        !recipients.has(email)
      ) {
        recipients.set(
          email,
          {
            email,
            source:
              'EXPLICIT',
          },
        );
      }
    }

    return Array.from(
      recipients.values(),
    );
  }

  private async isInCooldown(
    organizationId: string,
    deviceId: string,
    recipientEmail: string,
    cooldownMinutes: number,
    now: Date,
  ): Promise<boolean> {
    if (
      cooldownMinutes <= 0
    ) {
      return false;
    }

    const cutoff =
      new Date(
        now.getTime() -
        cooldownMinutes *
          60 *
          1000,
      );

    const previous =
      await this.prisma
        .notificationDelivery
        .findFirst({
          where: {
            organizationId,
            recipientEmail,
            eventType:
              'INCIDENT_OPENED',
            status: 'SENT',
            sentAt: {
              gte: cutoff,
            },
            alert: {
              deviceId,
            },
          },
          select: {
            id: true,
          },
        });

    return Boolean(previous);
  }

  private severityAllowed(
    severity: AlertSeverity,
    minimum:
      AlertSeverity,
  ): boolean {
    const ranking:
      Record<
        AlertSeverity,
        number
      > = {
      WARNING: 1,
      CRITICAL: 2,
    };

    return (
      ranking[severity] >=
      ranking[minimum]
    );
  }

  private deliveryDedupKey(
    alertId: string,
    eventType:
      NotificationEventType,
    recipientEmail: string,
  ): string {
    const recipientHash =
      createHash('sha256')
        .update(
          recipientEmail,
        )
        .digest('hex')
        .slice(0, 24);

    return [
      alertId,
      eventType,
      'EMAIL',
      recipientHash,
    ].join(':');
  }

  private subjectFor(
    alert: IncidentAlert,
    eventType:
      NotificationEventType,
  ): string {
    if (
      eventType ===
      'INCIDENT_RECOVERED'
    ) {
      return (
        `[PSOP] RECOVERED — ` +
        alert.device.name
      );
    }

    return (
      `[PSOP] ${alert.severity} — ` +
      alert.title
    );
  }

  private bodyFor(
    alert: IncidentAlert,
    eventType:
      NotificationEventType,
  ): string {
    const recovered =
      eventType ===
      'INCIDENT_RECOVERED';

    const durationSeconds =
      recovered &&
      alert.resolvedAt
        ? Math.max(
            0,
            Math.floor(
              (
                alert
                  .resolvedAt
                  .getTime() -
                alert
                  .openedAt
                  .getTime()
              ) / 1000,
            ),
          )
        : null;

    return [
      'PSOP incident notification',
      '',
      `Event: ${
        recovered
          ? 'RECOVERED'
          : 'OPENED'
      }`,
      `Severity: ${alert.severity}`,
      `Device: ${alert.device.name} (${alert.device.externalId})`,
      `Site: ${alert.device.site.name} (${alert.device.site.code})`,
      `Connectivity: ${alert.connectivityState ?? 'UNKNOWN'}`,
      `Incident: ${alert.id}`,
      `Opened: ${alert.openedAt.toISOString()}`,
      recovered &&
      alert.resolvedAt
        ? `Recovered: ${alert.resolvedAt.toISOString()}`
        : null,
      durationSeconds !== null
        ? `Duration: ${durationSeconds} seconds`
        : null,
      '',
      alert.message,
    ]
      .filter(
        (
          line,
        ): line is string =>
          line !== null,
      )
      .join('\n');
  }

  private defaultPolicy(
    organizationId: string,
  ) {
    return {
      id: null,
      organizationId,
      enabled: false,
      minimumSeverity:
        'CRITICAL' as const,
      notifyOnRecovery: true,
      notifyAdmins: true,
      notifyOperators: true,
      explicitEmails:
        [] as string[],
      cooldownMinutes: 0,
      escalationDelayMinutes:
        0,
      createdAt: null,
      updatedAt: null,
    };
  }

  private toPublicDelivery(
    delivery: any,
  ) {
    return {
      id: delivery.id,
      alertId:
        delivery.alertId,
      eventType:
        delivery.eventType,
      channel:
        delivery.channel,
      recipientEmail:
        delivery.recipientEmail,
      recipientSource:
        delivery.recipientSource,
      status:
        delivery.status,
      subject:
        delivery.subject,
      eligibleAt:
        delivery.eligibleAt,
      attemptCount:
        delivery.attemptCount,
      lastAttemptAt:
        delivery.lastAttemptAt,
      nextAttemptAt:
        delivery.nextAttemptAt,
      sentAt:
        delivery.sentAt,
      lastError:
        delivery.lastError,
      createdAt:
        delivery.createdAt,
      updatedAt:
        delivery.updatedAt,
      incident: {
        id:
          delivery.alert.id,
        severity:
          delivery.alert.severity,
        status:
          delivery.alert.status,
        connectivityState:
          delivery.alert.connectivityState,
        openedAt:
          delivery.alert.openedAt,
        resolvedAt:
          delivery.alert.resolvedAt,
      },
      device: {
        id:
          delivery.alert.device.id,
        name:
          delivery.alert.device.name,
        externalId:
          delivery.alert.device.externalId,
        siteId:
          delivery.alert.device.site.id,
        siteCode:
          delivery.alert.device.site.code,
        siteName:
          delivery.alert.device.site.name,
      },
    };
  }
}
