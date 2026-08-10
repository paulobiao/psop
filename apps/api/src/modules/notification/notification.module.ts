import { Module } from '@nestjs/common';
import { NotificationController } from './controllers/notification.controller.js';
import { EmailProviderService } from './services/email-provider.service.js';
import { NotificationService } from './services/notification.service.js';
import { NotificationWorkerService } from './services/notification-worker.service.js';

@Module({
  controllers: [
    NotificationController,
  ],
  providers: [
    EmailProviderService,
    NotificationService,
    NotificationWorkerService,
  ],
  exports: [
    NotificationService,
  ],
})
export class NotificationModule {}
