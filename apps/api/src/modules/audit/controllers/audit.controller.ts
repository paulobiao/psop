import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { AuditService } from '../services/audit.service.js';

@Roles('ADMIN')
@Controller({
  path: 'audit-logs',
  version: '1',
})
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
  ) {}

  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query(
      'limit',
      new DefaultValuePipe(100),
      ParseIntPipe,
    )
    limit: number,
  ) {
    return this.auditService.findAll(
      user.organizationId,
      limit,
    );
  }
}
