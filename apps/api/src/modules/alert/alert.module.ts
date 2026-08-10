import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { AlertController } from './controllers/alert.controller.js';
import { AlertRepository } from './repositories/alert.repository.js';
import { AlertService } from './services/alert.service.js';

@Module({
  imports: [
    NotificationModule,
  ],
  controllers: [
    AlertController,
  ],
  providers: [
    AlertService,
    AlertRepository,
  ],
  exports: [
    AlertService,
  ],
})
export class AlertModule {}
