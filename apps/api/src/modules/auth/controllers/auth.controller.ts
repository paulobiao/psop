import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CookieOptions,
  Request,
  Response,
} from 'express';
import type {
  AuthenticatedRequest,
  SessionContext,
} from '../auth.types.js';
import { Public } from '../decorators/public.decorator.js';
import { Roles } from '../decorators/roles.decorator.js';
import { LoginDto } from '../dto/login.dto.js';
import { AuthService } from '../services/auth.service.js';

@Controller({
  path: 'auth',
  version: '1',
})
export class AuthController {
  private readonly refreshCookieName =
    'psop.refreshToken';

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() data: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true })
    response: Response,
  ) {
    const result = await this.authService.login(
      data,
      this.sessionContext(request),
    );

    this.setRefreshCookie(
      response,
      result.refreshToken,
    );

    return {
      accessToken: result.accessToken,
      user: result.user,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true })
    response: Response,
  ) {
    const refreshToken = this.readCookie(
      request,
      this.refreshCookieName,
    );

    if (!refreshToken) {
      throw new UnauthorizedException(
        'Session refresh is unavailable',
      );
    }

    const result = await this.authService.refresh(
      refreshToken,
      this.sessionContext(request),
    );

    this.setRefreshCookie(
      response,
      result.refreshToken,
    );

    return {
      accessToken: result.accessToken,
      user: result.user,
    };
  }

  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return request.user;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true })
    response: Response,
  ) {
    const result = await this.authService.logout(
      request.user.id,
      request.sessionId,
    );

    this.clearRefreshCookie(response);

    return result;
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true })
    response: Response,
  ) {
    const result =
      await this.authService.logoutAll(
        request.user.id,
        request.user.organizationId,
      );

    this.clearRefreshCookie(response);

    return result;
  }

  @Roles('ADMIN')
  @Get('sessions')
  listSessions(
    @Req() request: AuthenticatedRequest,
  ) {
    return this.authService.listSessions(
      request.user.organizationId,
      request.sessionId,
    );
  }

  @Roles('ADMIN')
  @Delete('sessions/:id')
  revokeSession(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.authService
      .revokeOrganizationSession(
        request.user.organizationId,
        id,
      );
  }

  @Roles('ADMIN')
  @Delete('users/:userId/sessions')
  revokeUserSessions(
    @Req() request: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe)
    userId: string,
  ) {
    return this.authService
      .revokeUserSessions(
        request.user.organizationId,
        userId,
      );
  }

  private sessionContext(
    request: Request,
  ): SessionContext {
    const forwarded =
      request.headers['x-forwarded-for'];

    const forwardedIp = Array.isArray(forwarded)
      ? forwarded[0]
      : forwarded?.split(',')[0]?.trim();

    return {
      ipAddress: forwardedIp || request.ip,
      userAgent:
        request.headers['user-agent'],
    };
  }

  private setRefreshCookie(
    response: Response,
    refreshToken: string,
  ): void {
    response.cookie(
      this.refreshCookieName,
      refreshToken,
      {
        ...this.cookieOptions(),
        maxAge:
          this.refreshExpiresSeconds() * 1000,
      },
    );
  }

  private clearRefreshCookie(
    response: Response,
  ): void {
    response.clearCookie(
      this.refreshCookieName,
      this.cookieOptions(),
    );
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure:
        this.configService.get<string>(
          'NODE_ENV',
        ) === 'production',
      path: '/api/v1/auth',
    };
  }

  private refreshExpiresSeconds(): number {
    return Number(
      this.configService.get<string>(
        'JWT_REFRESH_EXPIRES_SECONDS',
      ) ?? 2592000,
    );
  }

  private readCookie(
    request: Request,
    name: string,
  ): string | null {
    const cookieHeader =
      request.headers.cookie;

    if (!cookieHeader) {
      return null;
    }

    for (const part of cookieHeader.split(';')) {
      const separator = part.indexOf('=');

      if (separator < 0) {
        continue;
      }

      const key = part
        .slice(0, separator)
        .trim();

      if (key !== name) {
        continue;
      }

      return decodeURIComponent(
        part.slice(separator + 1).trim(),
      );
    }

    return null;
  }
}
