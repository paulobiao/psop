import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createTransport,
  type Transporter,
} from 'nodemailer';

interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

@Injectable()
export class EmailProviderService {
  private transporter:
    | Transporter
    | null = null;

  constructor(
    private readonly configService:
      ConfigService,
  ) {}

  getStatus() {
    const settings =
      this.readSettings();

    return {
      channel: 'EMAIL' as const,
      configured:
        settings.configured,
      hostConfigured:
        Boolean(settings.host),
      fromConfigured:
        Boolean(settings.from),
      authentication:
        settings.authState,
      secure:
        settings.secure,
      port:
        settings.port,
    };
  }

  async send(
    message: EmailMessage,
  ): Promise<void> {
    const settings =
      this.readSettings();

    if (!settings.configured) {
      throw new Error(
        'EMAIL_TRANSPORT_NOT_CONFIGURED',
      );
    }

    if (!this.transporter) {
      this.transporter =
        createTransport({
          host: settings.host,
          port: settings.port,
          secure: settings.secure,
          auth:
            settings.user &&
            settings.password
              ? {
                  user:
                    settings.user,
                  pass:
                    settings.password,
                }
              : undefined,
          connectionTimeout: 5_000,
          greetingTimeout: 5_000,
          socketTimeout: 10_000,
        });
    }

    await this.transporter.sendMail({
      from: settings.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }

  private readSettings() {
    const host =
      this.configService
        .get<string>('SMTP_HOST')
        ?.trim() || '';

    const from =
      this.configService
        .get<string>('SMTP_FROM')
        ?.trim() || '';

    const user =
      this.configService
        .get<string>('SMTP_USER')
        ?.trim() || '';

    const password =
      this.configService
        .get<string>('SMTP_PASSWORD')
        ?.trim() || '';

    const rawPort =
      Number(
        this.configService
          .get<string>('SMTP_PORT') ??
          '587',
      );

    const port =
      Number.isInteger(rawPort) &&
      rawPort > 0 &&
      rawPort <= 65_535
        ? rawPort
        : 587;

    const secureSetting =
      (
        this.configService
          .get<string>('SMTP_SECURE') ??
        ''
      )
        .trim()
        .toLowerCase();

    const secure =
      secureSetting === 'true' ||
      (
        secureSetting === '' &&
        port === 465
      );

    const authState =
      user && password
        ? 'AUTHENTICATED'
        : !user && !password
          ? 'NONE'
          : 'INCOMPLETE';

    return {
      host,
      from,
      user,
      password,
      port,
      secure,
      authState,
      configured:
        Boolean(host) &&
        Boolean(from) &&
        authState !== 'INCOMPLETE',
    };
  }
}
