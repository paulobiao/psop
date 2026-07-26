import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditController } from './controllers/audit.controller.js';
import { AuditInterceptor } from './interceptors/audit.interceptor.js';
import { AuditRepository } from './repositories/audit.repository.js';
import { AuditService } from './services/audit.service.js';

@Module({
  controllers: [AuditController],
  providers: [
    AuditRepository,
    AuditService,
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
  ],
  exports: [AuditService],
})
export class AuditModule {}
