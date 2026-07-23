import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeviceConnectivityEventsService } from './device-connectivity-events.service';

@Injectable()
export class DeviceConnectivityMonitorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DeviceConnectivityMonitorService.name);

  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;

  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;

  constructor(
    configService: ConfigService,
    private readonly connectivityEventsService: DeviceConnectivityEventsService,
  ) {
    const enabledValue =
      configService.get<string>('CONNECTIVITY_MONITOR_ENABLED') ?? 'true';

    this.enabled = !['false', '0', 'no', 'off'].includes(
      enabledValue.toLowerCase(),
    );

    this.intervalMs = this.secondsToMilliseconds(
      configService.get<string>('CONNECTIVITY_MONITOR_INTERVAL_SECONDS'),
      60,
    );

    this.initialDelayMs = this.secondsToMilliseconds(
      configService.get<string>('CONNECTIVITY_MONITOR_INITIAL_DELAY_SECONDS'),
      5,
    );
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Automatic connectivity monitoring is disabled');
      return;
    }

    this.logger.log(
      `Automatic connectivity monitoring enabled every ${
        this.intervalMs / 1000
      } seconds`,
    );

    this.schedule(this.initialDelayMs);
  }

  onModuleDestroy(): void {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.runAndScheduleNext();
    }, delayMs);

    this.timer.unref();
  }

  private async runAndScheduleNext(): Promise<void> {
    if (this.running || this.stopped) {
      return;
    }

    this.running = true;

    try {
      const result = await this.connectivityEventsService.evaluateFleet();

      if (result.createdEvents > 0) {
        this.logger.log(
          `Connectivity evaluation created ${result.createdEvents} event(s)`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Automatic connectivity evaluation failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
      this.schedule(this.intervalMs);
    }
  }

  private secondsToMilliseconds(
    value: string | undefined,
    fallbackSeconds: number,
  ): number {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallbackSeconds * 1000;
    }

    return Math.max(1, parsed) * 1000;
  }
}
