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
  AuthFlowResult,
  SessionContext,
} from '../auth.types.js';
import { Public } from '../decorators/public.decorator.js';
import { Roles } from '../decorators/roles.decorator.js';
import { CompletePasswordChangeDto } from '../dto/complete-password-change.dto.js';
import { LoginDto } from '../dto/login.dto.js';
import { MfaCodeDto } from '../dto/mfa-code.dto.js';
import { MfaSecurityActionDto } from '../dto/mfa-security-action.dto.js';
import { VerifyMfaDto } from '../dto/verify-mfa.dto.js';
import { AuthService } from '../services/auth.service.js';

@Controller({
  path: 'auth',
  version: '1',
})
export class AuthController {
  private readonly refreshCookieName =
    'psop.refreshToken';

  constructor(
    private readonly authService:
      AuthService,
    private readonly configService:
      ConfigService,
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
    return this.present(
      await this.authService.login(
        data,
        this.context(request),
      ),
      response,
    );
  }

  @Public()
  @Post('password/change')
  @HttpCode(HttpStatus.OK)
  async changeFirstPassword(
    @Body()
    data: CompletePasswordChangeDto,
    @Req() request: Request,
    @Res({ passthrough: true })
    response: Response,
  ) {
    return this.present(
      await this.authService
        .completePasswordChange(
          data.challengeToken,
          data.newPassword,
          this.context(request),
        ),
      response,
    );
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  async verifyMfa(
    @Body() data: VerifyMfaDto,
    @Req() request: Request,
    @Res({ passthrough: true })
    response: Response,
  ) {
    return this.present(
      await this.authService
        .verifyMfaChallenge(
          data.challengeToken,
          data.code,
          this.context(request),
        ),
      response,
    );
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true })
    response: Response,
  ) {
    const refreshToken =
      this.readCookie(
        request,
        this.refreshCookieName,
      );

    if (!refreshToken) {
      throw new UnauthorizedException(
        'Session refresh is unavailable',
      );
    }

    return this.present(
      await this.authService.refresh(
        refreshToken,
        this.context(request),
      ),
      response,
    );
  }

  @Get('me')
  me(
    @Req()
    request: AuthenticatedRequest,
  ) {
    return request.user;
  }

  @Get('mfa/status')
  mfaStatus(
    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.authService
      .getMfaStatus(
        request.user.id,
      );
  }

  @Post('mfa/setup')
  setupMfa(
    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.authService
      .beginMfaSetup(
        request.user.id,
      );
  }

  @Post('mfa/enable')
  @HttpCode(HttpStatus.OK)
  enableMfa(
    @Req()
    request: AuthenticatedRequest,
    @Body() data: MfaCodeDto,
  ) {
    return this.authService
      .enableMfa(
        request.user.id,
        request.user.organizationId,
        request.sessionId,
        data.code,
      );
  }

  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  disableMfa(
    @Req()
    request: AuthenticatedRequest,
    @Body()
    data: MfaSecurityActionDto,
  ) {
    return this.authService
      .disableMfa(
        request.user.id,
        request.user.organizationId,
        request.sessionId,
        data.password,
        data.code,
      );
  }

  @Post('mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  recoveryCodes(
    @Req()
    request: AuthenticatedRequest,
    @Body()
    data: MfaSecurityActionDto,
  ) {
    return this.authService
      .regenerateRecoveryCodes(
        request.user.id,
        request.user.organizationId,
        request.sessionId,
        data.password,
        data.code,
      );
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req()
    request: AuthenticatedRequest,
    @Res({ passthrough: true })
    response: Response,
  ) {
    const result =
      await this.authService.logout(
        request.user.id,
        request.sessionId,
      );

    this.clearRefreshCookie(
      response,
    );

    return result;
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(
    @Req()
    request: AuthenticatedRequest,
    @Res({ passthrough: true })
    response: Response,
  ) {
    const result =
      await this.authService
        .logoutAll(
          request.user.id,
          request.user.organizationId,
        );

    this.clearRefreshCookie(
      response,
    );

    return result;
  }

  @Roles('ADMIN')
  @Get('sessions')
  sessions(
    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.authService
      .listSessions(
        request.user.organizationId,
        request.sessionId,
      );
  }

  @Roles('ADMIN')
  @Delete('sessions/:id')
  revokeSession(
    @Req()
    request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe)
    id: string,
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
    @Req()
    request: AuthenticatedRequest,
    @Param(
      'userId',
      ParseUUIDPipe,
    )
    userId: string,
  ) {
    return this.authService
      .revokeUserSessions(
        request.user.organizationId,
        userId,
      );
  }

  private present(
    result: AuthFlowResult,
    response: Response,
  ) {
    if (
      result.stage !==
      'AUTHENTICATED'
    ) {
      return result;
    }

    this.setRefreshCookie(
      response,
      result.refreshToken,
    );

    return {
      stage: result.stage,
      accessToken:
        result.accessToken,
      user: result.user,
    };
  }

  private context(
    request: Request,
  ): SessionContext {
    const forwarded =
      request.headers[
        'x-forwarded-for'
      ];

    const forwardedIp =
      Array.isArray(forwarded)
        ? forwarded[0]
        : forwarded
            ?.split(',')[0]
            ?.trim();

    return {
      ipAddress:
        forwardedIp || request.ip,
      userAgent:
        request.headers[
          'user-agent'
        ],
    };
  }

  private setRefreshCookie(
    response: Response,
    token: string,
  ) {
    response.cookie(
      this.refreshCookieName,
      token,
      {
        ...this.cookieOptions(),
        maxAge:
          this.refreshExpiresSeconds() *
          1000,
      },
    );
  }

  private clearRefreshCookie(
    response: Response,
  ) {
    response.clearCookie(
      this.refreshCookieName,
      this.cookieOptions(),
    );
  }

  private cookieOptions():
  CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure:
        this.configService
          .get<string>(
            'NODE_ENV',
          ) === 'production',
      path: '/api/v1/auth',
    };
  }

  private refreshExpiresSeconds():
  number {
    return Number(
      this.configService
        .get<string>(
          'JWT_REFRESH_EXPIRES_SECONDS',
        ) ?? 2592000,
    );
  }

  private readCookie(
    request: Request,
    name: string,
  ): string | null {
    const header =
      request.headers.cookie;

    if (!header) {
      return null;
    }

    for (
      const part of header.split(';')
    ) {
      const index =
        part.indexOf('=');

      if (index < 0) {
        continue;
      }

      if (
        part
          .slice(0, index)
          .trim() !== name
      ) {
        continue;
      }

      return decodeURIComponent(
        part
          .slice(index + 1)
          .trim(),
      );
    }

    return null;
  }
}
