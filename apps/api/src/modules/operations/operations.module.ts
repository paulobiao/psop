import { Module } from '@nestjs/common';
import { AlertModule } from '../alert/alert.module.js';
import { DeviceModule } from '../device/device.module.js';
import { OperationsController } from './controllers/operations.controller.js';
import { OperationsOverviewService } from './services/operations-overview.service.js';

@Module({
  imports: [DeviceModule, AlertModule],
  controllers: [OperationsController],
  providers: [OperationsOverviewService],
})
export class OperationsModule {}
