import { Module } from '@nestjs/common';
import { DeviceController } from './controllers/device.controller';
import { DeviceRepository } from './repositories/device.repository';
import { DeviceService } from './services/device.service';

@Module({
  controllers: [DeviceController],
  providers: [DeviceService, DeviceRepository],
  exports: [DeviceService],
})
export class DeviceModule {}
