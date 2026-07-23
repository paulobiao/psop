import { Controller, Get } from '@nestjs/common';
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
  getOverview() {
    return this.operationsOverviewService.getOverview();
  }
}
