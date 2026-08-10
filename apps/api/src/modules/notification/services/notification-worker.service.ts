import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationService } from './notification.service.js';

@Injectable()
export class NotificationWorkerService
  implements
    OnModuleInit,
    OnModuleDestroy
{
  private readonly logger =
    new Logger(
      NotificationWorkerService.name,
    );

  private timer:
    NodeJS.Timeout | null = null;

  constructor(
    private readonly configService:
      ConfigService,
    private readonly notificationService:
      NotificationService,
  ) {}

  onModuleInit(): void {
    const nodeEnv =
      this.configService
        .get<string>('NODE_ENV');

    const configured =
      (
        this.configService
          .get<string>(
            'NOTIFICATION_WORKER_ENABLED',
          ) ??
        'true'
      )
        .trim()
        .toLowerCase();

    if (
      nodeEnv === 'test' ||
      configured === 'false'
    ) {
      return;
    }

    const intervalMs =
      60_000;

    this.timer =
      setInterval(() => {
        void this.run();
      }, intervalMs);

    this.timer.unref();

    void this.run();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(
        this.timer,
      );
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    try {
      await this
        .notificationService
        .processDueAcrossOrganizations();
    } catch {
      this.logger.warn(
        'Notification worker cycle failed',
      );
    }
  }
}
