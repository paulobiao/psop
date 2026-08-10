import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { UpdateNotificationPolicyDto } from '../dto/update-notification-policy.dto.js';
import { NotificationService } from '../services/notification.service.js';

@Roles('ADMIN')
@Controller({
  path: 'notifications',
  version: '1',
})
export class NotificationController {
  constructor(
    private readonly notificationService:
      NotificationService,
  ) {}

  @Get('policy')
  getPolicy(
    @CurrentUser() user: AuthUser,
  ) {
    return this.notificationService
      .getPolicy(
        user.organizationId,
      );
  }

  @Patch('policy')
  updatePolicy(
    @CurrentUser() user: AuthUser,
    @Body()
    input:
      UpdateNotificationPolicyDto,
  ) {
    return this.notificationService
      .updatePolicy(
        user.organizationId,
        input,
      );
  }

  @Get('transport')
  getTransportStatus() {
    return this.notificationService
      .getTransportStatus();
  }

  @Get('deliveries')
  findDeliveries(
    @CurrentUser() user: AuthUser,
    @Query(
      'limit',
      new DefaultValuePipe(100),
      ParseIntPipe,
    )
    limit: number,
  ) {
    return this.notificationService
      .findDeliveries(
        user.organizationId,
        limit,
      );
  }

  @Post('deliveries/process')
  processDue(
    @CurrentUser() user: AuthUser,
  ) {
    return this.notificationService
      .processDueForOrganization(
        user.organizationId,
      );
  }

  @Post('deliveries/:id/retry')
  retry(
    @CurrentUser() user: AuthUser,
    @Param(
      'id',
      ParseUUIDPipe,
    )
    id: string,
  ) {
    return this.notificationService
      .retryDelivery(
        user.organizationId,
        id,
      );
  }
}
