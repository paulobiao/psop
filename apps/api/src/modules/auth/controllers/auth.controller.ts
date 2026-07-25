import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth.types.js';
import { Public } from '../decorators/public.decorator.js';
import { LoginDto } from '../dto/login.dto.js';
import { AuthService } from '../services/auth.service.js';

@Controller({
  path: 'auth',
  version: '1',
})
export class AuthController {
  constructor(
    private readonly authService: AuthService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() data: LoginDto) {
    return this.authService.login(data);
  }

  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return request.user;
  }
}
