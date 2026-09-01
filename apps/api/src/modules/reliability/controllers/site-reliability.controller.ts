import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { DeviceAvailabilityQueryDto } from '../../device/dto/device-availability-query.dto.js';
import { SiteReliabilityService } from '../services/site-reliability.service.js';

@Controller({
  path: 'sites',
  version: '1',
})
export class SiteReliabilityController {
  constructor(
    private readonly siteReliabilityService: SiteReliabilityService,
  ) {}

  /**
   * GET /api/v1/sites/:siteId/reliability
   *   ?window=24h|7d|30d   (default 24h)
   *   ?from=ISO&to=ISO     (explicit range wins; `to` defaults to now)
   *
   * Read-only. Same period semantics as GET /devices/:id/availability.
   */
  @Get(':siteId/reliability')
  getReliability(
    @CurrentUser() user: AuthUser,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: DeviceAvailabilityQueryDto,
  ) {
    return this.siteReliabilityService.getSiteReliability(
      user.organizationId,
      siteId,
      query,
    );
  }
}
