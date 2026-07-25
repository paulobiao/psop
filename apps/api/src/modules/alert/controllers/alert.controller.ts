import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { AlertService } from '../services/alert.service.js';

@Controller({
  path: 'alerts',
  version: '1',
})
export class AlertController {
  constructor(
    private readonly alertService: AlertService,
  ) {}

  @Get('active')
  findActive(
    @CurrentUser() user: AuthUser,
    @Query('deviceId') deviceId?: string,
  ) {
    return this.alertService.findActive(
      user.organizationId,
      deviceId,
    );
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('deviceId') deviceId?: string,
  ) {
    return this.alertService.findAll(
      user.organizationId,
      status,
      deviceId,
    );
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.alertService.findOne(
      user.organizationId,
      id,
    );
  }

  @Roles('ADMIN', 'OPERATOR')
  @Patch(':id/resolve')
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.alertService.resolve(
      user.organizationId,
      id,
    );
  }
}
