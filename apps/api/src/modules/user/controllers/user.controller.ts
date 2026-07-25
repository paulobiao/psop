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
import { ChangeUserPasswordDto } from '../dto/change-user-password.dto.js';
import { CreateUserDto } from '../dto/create-user.dto.js';
import { UpdateUserDto } from '../dto/update-user.dto.js';
import { UserService } from '../services/user.service.js';

@Roles('ADMIN')
@Controller({
  path: 'users',
  version: '1',
})
export class UserController {
  constructor(
    private readonly userService: UserService,
  ) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.userService.findAll(
      user.organizationId,
    );
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.userService.findOne(
      user.organizationId,
      id,
    );
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() data: CreateUserDto,
  ) {
    return this.userService.create(
      user.organizationId,
      data,
    );
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: UpdateUserDto,
  ) {
    return this.userService.update(
      user.organizationId,
      user.id,
      id,
      data,
    );
  }

  @Patch(':id/password')
  changePassword(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: ChangeUserPasswordDto,
  ) {
    return this.userService.changePassword(
      user.organizationId,
      id,
      data,
    );
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.userService.remove(
      user.organizationId,
      user.id,
      id,
    );
  }
}
