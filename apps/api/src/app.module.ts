import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './modules/health/health.module';
import { SiteModule } from './modules/site/site.module';
import { DeviceModule } from './modules/device/device.module';
import { OperationsModule } from './modules/operations/operations.module';
import { PrismaModule } from './database/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    AuthModule,
    UserModule,
    HealthModule,
    SiteModule,
    DeviceModule,
    OperationsModule,
  ],
})
export class AppModule {}
