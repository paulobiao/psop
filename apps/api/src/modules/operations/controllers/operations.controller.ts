import { Controller, Get } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { OperationsOverviewService } from '../services/operations-overview.service.js';

@Controller({
  path: 'operations',
  version: '1',
})
export class OperationsController {
  constructor(
    private readonly operationsOverviewService: OperationsOverviewService,
  ) {}

  @Get('overview')
  getOverview(@CurrentUser() user: AuthUser) {
    return this.operationsOverviewService.getOverview(
      user.organizationId,
    );
  }
}
