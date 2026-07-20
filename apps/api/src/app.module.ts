import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './modules/health/health.module';
import { SiteModule } from './modules/site/site.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HealthModule,
    SiteModule,
  ],
})
export class AppModule {}
