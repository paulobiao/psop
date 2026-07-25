import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { CreateSiteDto } from '../dto/create-site.dto';
import { UpdateSiteDto } from '../dto/update-site.dto';
import { SiteService } from '../services/site.service';

@Controller({
  path: 'sites',
  version: '1',
})
export class SiteController {
  constructor(private readonly siteService: SiteService) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.siteService.findAll(user.organizationId);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.siteService.findOne(
      user.organizationId,
      id,
    );
  }

  @Roles('ADMIN', 'OPERATOR')
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() data: CreateSiteDto,
  ) {
    return this.siteService.create(
      user.organizationId,
      data,
    );
  }

  @Roles('ADMIN', 'OPERATOR')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: UpdateSiteDto,
  ) {
    return this.siteService.update(
      user.organizationId,
      id,
      data,
    );
  }

  @Roles('ADMIN', 'OPERATOR')
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.siteService.remove(
      user.organizationId,
      id,
    );
  }
}
