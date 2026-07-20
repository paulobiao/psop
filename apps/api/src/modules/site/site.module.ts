import { Module } from '@nestjs/common';
import { SiteController } from './controllers/site.controller';
import { SiteRepository } from './repositories/site.repository';
import { SiteService } from './services/site.service';

@Module({
  controllers: [SiteController],
  providers: [SiteService, SiteRepository],
})
export class SiteModule {}
