import { Controller, Get } from '@nestjs/common';
import { SiteService } from '../services/site.service';

@Controller({
  path: 'sites',
  version: '1',
})
export class SiteController {
  constructor(private readonly siteService: SiteService) {}

  @Get()
  findAll() {
    return this.siteService.findAll();
  }
}