import { Controller, Get, Query } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { DeviceAvailabilityQueryDto } from '../../device/dto/device-availability-query.dto.js';
import { FleetReliabilityService } from '../services/fleet-reliability.service.js';

@Controller({
  path: 'fleet',
  version: '1',
})
export class FleetReliabilityController {
  constructor(
    private readonly fleetReliabilityService: FleetReliabilityService,
  ) {}

  /**
   * GET /api/v1/fleet/reliability
   *   ?window=24h|7d|30d   (default 24h)
   *   ?from=ISO&to=ISO     (explicit range wins; `to` defaults to now)
   *
   * Read-only. Consolidates every site of the authenticated organization.
   */
  @Get('reliability')
  getReliability(
    @CurrentUser() user: AuthUser,
    @Query() query: DeviceAvailabilityQueryDto,
  ) {
    return this.fleetReliabilityService.getFleetReliability(
      user.organizationId,
      query,
    );
  }
}
