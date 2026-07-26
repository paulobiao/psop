import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { User } from '../../../../generated/prisma/client.js';
import type {
  AuthUser,
  JwtPayload,
  RefreshJwtPayload,
  SessionContext,
} from '../auth.types.js';
import type { LoginDto } from '../dto/login.dto.js';
import { AuthRepository } from '../repositories/auth.repository.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly authRepository: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async login(
    data: LoginDto,
    context: SessionContext,
  ) {
    const email = data.email.trim().toLowerCase();

    const user =
      await this.authRepository.findActiveByEmail(email);

    if (
      !user ||
      !(await compare(data.password, user.passwordHash))
    ) {
      throw new UnauthorizedException(
        'Invalid email or password',
      );
    }

    await this.authRepository.markLogin(user.id);

    const authUser = this.toAuthUser(user);
    const sessionId = randomUUID();

    const tokens = await this.issueTokens(
      authUser,
      sessionId,
    );

    await this.authRepository.createSession({
      id: sessionId,
      organizationId: authUser.organizationId,
      userId: authUser.id,
      refreshTokenHash: this.hashRefreshToken(
        tokens.refreshToken,
      ),
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      expiresAt: this.refreshExpiresAt(),
    });

    return {
      ...tokens,
      user: authUser,
    };
  }

  async refresh(
    refreshToken: string,
    context: SessionContext,
  ) {
    let payload: RefreshJwtPayload;

    try {
      payload =
        await this.jwtService.verifyAsync<RefreshJwtPayload>(
          refreshToken,
          {
            secret: this.refreshSecret(),
          },
        );
    } catch {
      throw new UnauthorizedException(
        'Session refresh is unavailable',
      );
    }

    if (
      payload.type !== 'refresh' ||
      !payload.sid ||
      !payload.sub
    ) {
      throw new UnauthorizedException(
        'Session refresh is unavailable',
      );
    }

    const [user, session] = await Promise.all([
      this.authRepository.findActiveById(payload.sub),
      this.authRepository.findActiveSession(
        payload.sid,
        payload.sub,
      ),
    ]);

    if (!user || !session) {
      throw new UnauthorizedException(
        'Session refresh is unavailable',
      );
    }

    const currentHash =
      this.hashRefreshToken(refreshToken);

    if (
      !this.hashesMatch(
        currentHash,
        session.refreshTokenHash,
      )
    ) {
      await this.authRepository.revokeSessionForUser(
        session.id,
        user.id,
      );

      throw new UnauthorizedException(
        'Session refresh is unavailable',
      );
    }

    const authUser = this.toAuthUser(user);

    const tokens = await this.issueTokens(
      authUser,
      session.id,
    );

    const rotation =
      await this.authRepository.rotateSession(
        session.id,
        user.id,
        currentHash,
        this.hashRefreshToken(
          tokens.refreshToken,
        ),
        this.refreshExpiresAt(),
        context,
      );

    if (rotation.count !== 1) {
      throw new UnauthorizedException(
        'Session refresh is unavailable',
      );
    }

    return {
      ...tokens,
      user: authUser,
    };
  }

  async validateSession(
    userId: string,
    sessionId: string,
  ): Promise<AuthUser> {
    const [user, session] = await Promise.all([
      this.authRepository.findActiveById(userId),
      this.authRepository.findActiveSession(
        sessionId,
        userId,
      ),
    ]);

    if (!user || !session) {
      throw new UnauthorizedException(
        'Authentication required',
      );
    }

    return this.toAuthUser(user);
  }

  async logout(
    userId: string,
    sessionId: string,
  ) {
    await this.authRepository.revokeSessionForUser(
      sessionId,
      userId,
    );

    return {
      success: true,
    };
  }

  async logoutAll(
    userId: string,
    organizationId: string,
  ) {
    const result =
      await this.authRepository.revokeAllSessionsForUser(
        userId,
        organizationId,
      );

    return {
      success: true,
      revokedSessions: result.count,
    };
  }

  async listSessions(
    organizationId: string,
    currentSessionId: string,
  ) {
    const sessions =
      await this.authRepository.listSessions(
        organizationId,
      );

    const now = Date.now();

    return sessions.map((session) => ({
      id: session.id,
      userId: session.userId,
      userName: session.user.name,
      userEmail: session.user.email,
      userRole: session.user.role,
      userStatus: session.user.status,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      current: session.id === currentSessionId,
      state: session.revokedAt
        ? 'REVOKED'
        : session.expiresAt.getTime() <= now
          ? 'EXPIRED'
          : 'ACTIVE',
    }));
  }

  async revokeOrganizationSession(
    organizationId: string,
    sessionId: string,
  ) {
    const result =
      await this.authRepository
        .revokeSessionForOrganization(
          sessionId,
          organizationId,
        );

    if (result.count !== 1) {
      throw new NotFoundException(
        'Active session not found',
      );
    }

    return {
      success: true,
      revokedSessions: 1,
    };
  }

  async revokeUserSessions(
    organizationId: string,
    userId: string,
  ) {
    const user =
      await this.authRepository
        .findUserInOrganization(
          userId,
          organizationId,
        );

    if (!user) {
      throw new NotFoundException(
        'User not found',
      );
    }

    const result =
      await this.authRepository
        .revokeAllSessionsForUser(
          userId,
          organizationId,
        );

    return {
      success: true,
      revokedSessions: result.count,
    };
  }

  private async issueTokens(
    user: AuthUser,
    sessionId: string,
  ) {
    const accessPayload: JwtPayload = {
      sub: user.id,
      sid: sessionId,
      jti: randomUUID(),
      organizationId: user.organizationId,
      email: user.email,
      role: user.role,
      type: 'access',
    };

    const refreshPayload: RefreshJwtPayload = {
      sub: user.id,
      sid: sessionId,
      jti: randomUUID(),
      type: 'refresh',
    };

    const [accessToken, refreshToken] =
      await Promise.all([
        this.jwtService.signAsync(
          accessPayload,
          {
            secret: this.accessSecret(),
            expiresIn: this.accessExpiresSeconds(),
          },
        ),
        this.jwtService.signAsync(
          refreshPayload,
          {
            secret: this.refreshSecret(),
            expiresIn: this.refreshExpiresSeconds(),
          },
        ),
      ]);

    return {
      accessToken,
      refreshToken,
    };
  }

  private accessSecret(): string {
    return this.configService.getOrThrow<string>(
      'JWT_SECRET',
    );
  }

  private refreshSecret(): string {
    return this.configService.getOrThrow<string>(
      'JWT_REFRESH_SECRET',
    );
  }

  private accessExpiresSeconds(): number {
    return Number(
      this.configService.get<string>(
        'JWT_EXPIRES_SECONDS',
      ) ?? 900,
    );
  }

  private refreshExpiresSeconds(): number {
    return Number(
      this.configService.get<string>(
        'JWT_REFRESH_EXPIRES_SECONDS',
      ) ?? 2592000,
    );
  }

  private refreshExpiresAt(): Date {
    return new Date(
      Date.now() +
        this.refreshExpiresSeconds() * 1000,
    );
  }

  private hashRefreshToken(token: string): string {
    return createHash('sha256')
      .update(token)
      .digest('hex');
  }

  private hashesMatch(
    first: string,
    second: string,
  ): boolean {
    const firstBuffer = Buffer.from(first);
    const secondBuffer = Buffer.from(second);

    return (
      firstBuffer.length === secondBuffer.length &&
      timingSafeEqual(
        firstBuffer,
        secondBuffer,
      )
    );
  }

  private toAuthUser(user: User): AuthUser {
    return {
      id: user.id,
      organizationId: user.organizationId,
      name: user.name,
      email: user.email,
      role: user.role,
    };
  }
}
