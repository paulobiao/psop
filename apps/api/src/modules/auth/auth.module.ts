import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './controllers/auth.controller.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { AuthRepository } from './repositories/auth.repository.js';
import { AuthService } from './services/auth.service.js';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthRepository,
    AuthService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
