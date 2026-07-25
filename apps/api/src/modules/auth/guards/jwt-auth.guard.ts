import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type {
  AuthenticatedRequest,
  JwtPayload,
} from '../auth.types.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { AuthService } from '../services/auth.service.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {}

  async canActivate(
    context: ExecutionContext,
  ): Promise<boolean> {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(
        IS_PUBLIC_KEY,
        [context.getHandler(), context.getClass()],
      );

    if (isPublic) {
      return true;
    }

    const request =
      context.switchToHttp().getRequest<AuthenticatedRequest>();

    const token = this.extractToken(
      request.headers.authorization,
    );

    if (!token) {
      throw new UnauthorizedException(
        'Authentication required',
      );
    }

    try {
      const payload =
        await this.jwtService.verifyAsync<JwtPayload>(
          token,
          {
            secret:
              this.configService.getOrThrow<string>(
                'JWT_SECRET',
              ),
          },
        );

      request.user =
        await this.authService.validateUser(payload.sub);

      return true;
    } catch {
      throw new UnauthorizedException(
        'Authentication required',
      );
    }
  }

  private extractToken(
    authorization?: string,
  ): string | null {
    const [type, token] = authorization?.split(' ') ?? [];

    return type === 'Bearer' && token ? token : null;
  }
}
