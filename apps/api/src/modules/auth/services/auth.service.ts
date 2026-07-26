import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  compare,
  hash,
} from 'bcryptjs';
import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type {
  User,
} from '../../../../generated/prisma/client.js';
import type {
  AuthChallengePayload,
  AuthChallengeStage,
  AuthFlowResult,
  AuthenticatedAuthResult,
  AuthUser,
  JwtPayload,
  PendingAuthResult,
  RefreshJwtPayload,
  SessionContext,
} from '../auth.types.js';
import type { LoginDto } from '../dto/login.dto.js';
import { AuthRepository } from '../repositories/auth.repository.js';
import { TotpService } from './totp.service.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly authRepository:
      AuthRepository,
    private readonly jwtService:
      JwtService,
    private readonly configService:
      ConfigService,
    private readonly totpService:
      TotpService,
  ) {}

  async login(
    data: LoginDto,
    context: SessionContext,
  ): Promise<AuthFlowResult> {
    const email =
      data.email.trim().toLowerCase();

    const user =
      await this.authRepository
        .findActiveByEmail(email);

    if (
      !user ||
      !(await compare(
        data.password,
        user.passwordHash,
      ))
    ) {
      throw new UnauthorizedException(
        'Invalid email or password',
      );
    }

    if (user.mustChangePassword) {
      return this.createChallenge(
        user,
        'PASSWORD_CHANGE',
        context,
      );
    }

    if (user.mfaEnabled) {
      return this.createChallenge(
        user,
        'MFA',
        context,
      );
    }

    return this.createSession(
      user,
      context,
    );
  }

  async completePasswordChange(
    challengeToken: string,
    newPassword: string,
    context: SessionContext,
  ): Promise<AuthFlowResult> {
    const result =
      await this.resolveChallenge(
        challengeToken,
        'PASSWORD_CHANGE',
      );

    if (
      !result.user
        .mustChangePassword
    ) {
      throw new UnauthorizedException(
        'Password-change challenge is unavailable',
      );
    }

    if (
      await compare(
        newPassword,
        result.user.passwordHash,
      )
    ) {
      throw new BadRequestException(
        'The new password must be different from the temporary password',
      );
    }

    const consumed =
      await this.authRepository
        .consumeChallenge(
          result.challengeId,
          result.user.id,
          'PASSWORD_CHANGE',
        );

    if (consumed.count !== 1) {
      throw new UnauthorizedException(
        'Password-change challenge is unavailable',
      );
    }

    const updated =
      await this.authRepository
        .updatePasswordRequirement(
          result.user.id,
          await hash(
            newPassword,
            12,
          ),
          false,
        );

    await this.authRepository
      .revokeAllSessionsForUser(
        updated.id,
        updated.organizationId,
      );

    if (updated.mfaEnabled) {
      return this.createChallenge(
        updated,
        'MFA',
        context,
      );
    }

    return this.createSession(
      updated,
      context,
    );
  }

  async verifyMfaChallenge(
    challengeToken: string,
    code: string,
    context: SessionContext,
  ): Promise<AuthFlowResult> {
    const result =
      await this.resolveChallenge(
        challengeToken,
        'MFA',
      );

    if (
      !result.user.mfaEnabled ||
      !(await this.verifyMfaCode(
        result.user,
        code,
        true,
      ))
    ) {
      throw new UnauthorizedException(
        'Invalid authentication code',
      );
    }

    const consumed =
      await this.authRepository
        .consumeChallenge(
          result.challengeId,
          result.user.id,
          'MFA',
        );

    if (consumed.count !== 1) {
      throw new UnauthorizedException(
        'MFA challenge is unavailable',
      );
    }

    return this.createSession(
      result.user,
      context,
    );
  }

  async refresh(
    refreshToken: string,
    context: SessionContext,
  ): Promise<AuthenticatedAuthResult> {
    let payload:
      RefreshJwtPayload;

    try {
      payload =
        await this.jwtService
          .verifyAsync<RefreshJwtPayload>(
            refreshToken,
            {
              secret:
                this.refreshSecret(),
            },
          );
    } catch {
      throw new UnauthorizedException(
        'Session refresh is unavailable',
      );
    }

    const [user, session] =
      await Promise.all([
        this.authRepository
          .findActiveById(
            payload.sub,
          ),
        this.authRepository
          .findActiveSession(
            payload.sid,
            payload.sub,
          ),
      ]);

    if (
      payload.type !== 'refresh' ||
      !user ||
      !session ||
      user.mustChangePassword
    ) {
      throw new UnauthorizedException(
        'Session refresh is unavailable',
      );
    }

    const currentHash =
      this.hashRefreshToken(
        refreshToken,
      );

    if (
      !this.hashesMatch(
        currentHash,
        session.refreshTokenHash,
      )
    ) {
      await this.authRepository
        .revokeSessionForUser(
          session.id,
          user.id,
        );

      throw new UnauthorizedException(
        'Session refresh is unavailable',
      );
    }

    const authUser =
      this.toAuthUser(user);

    const tokens =
      await this.issueTokens(
        authUser,
        session.id,
      );

    const rotation =
      await this.authRepository
        .rotateSession(
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
      stage: 'AUTHENTICATED',
      ...tokens,
      user: authUser,
    };
  }

  async validateSession(
    userId: string,
    sessionId: string,
  ): Promise<AuthUser> {
    const [user, session] =
      await Promise.all([
        this.authRepository
          .findActiveById(userId),
        this.authRepository
          .findActiveSession(
            sessionId,
            userId,
          ),
      ]);

    if (
      !user ||
      !session ||
      user.mustChangePassword
    ) {
      throw new UnauthorizedException(
        'Authentication required',
      );
    }

    return this.toAuthUser(user);
  }

  async getMfaStatus(
    userId: string,
  ) {
    const user =
      await this.requireUser(userId);

    return {
      enabled:
        user.mfaEnabled,
      enabledAt:
        user.mfaEnabledAt,
      recoveryCodeCount:
        this.recoveryHashes(
          user,
        ).length,
      mustChangePassword:
        user.mustChangePassword,
    };
  }

  async beginMfaSetup(
    userId: string,
  ) {
    const user =
      await this.requireUser(userId);

    if (user.mfaEnabled) {
      throw new BadRequestException(
        'Two-factor authentication is already enabled',
      );
    }

    const secret =
      this.totpService
        .generateSecret();

    await this.authRepository
      .saveMfaSecret(
        user.id,
        this.totpService
          .encryptSecret(secret),
      );

    return {
      secret,
      otpAuthUri:
        this.totpService
          .createOtpAuthUri(
            user.email,
            secret,
          ),
    };
  }

  async enableMfa(
    userId: string,
    organizationId: string,
    sessionId: string,
    code: string,
  ) {
    const user =
      await this.requireUser(userId);

    if (
      !user.mfaSecretEncrypted
    ) {
      throw new BadRequestException(
        'Begin MFA setup before enabling it',
      );
    }

    const secret =
      this.totpService
        .decryptSecret(
          user.mfaSecretEncrypted,
        );

    if (
      !this.totpService
        .verifyCode(
          secret,
          code,
        )
    ) {
      throw new UnauthorizedException(
        'Invalid authentication code',
      );
    }

    const recoveryCodes =
      this.totpService
        .generateRecoveryCodes();

    await this.authRepository
      .enableMfa(
        user.id,
        recoveryCodes.map(
          (recoveryCode) =>
            this.totpService
              .hashRecoveryCode(
                recoveryCode,
              ),
        ),
      );

    await this.authRepository
      .revokeAllSessionsExcept(
        user.id,
        organizationId,
        sessionId,
      );

    return {
      enabled: true,
      recoveryCodes,
    };
  }

  async disableMfa(
    userId: string,
    organizationId: string,
    sessionId: string,
    password: string,
    code: string,
  ) {
    const user =
      await this.requireUser(userId);

    await this.verifyPasswordAndMfa(
      user,
      password,
      code,
    );

    await this.authRepository
      .disableMfa(user.id);

    await this.authRepository
      .revokeAllSessionsExcept(
        user.id,
        organizationId,
        sessionId,
      );

    return {
      enabled: false,
    };
  }

  async regenerateRecoveryCodes(
    userId: string,
    organizationId: string,
    sessionId: string,
    password: string,
    code: string,
  ) {
    const user =
      await this.requireUser(userId);

    await this.verifyPasswordAndMfa(
      user,
      password,
      code,
    );

    const recoveryCodes =
      this.totpService
        .generateRecoveryCodes();

    await this.authRepository
      .replaceRecoveryCodes(
        user.id,
        recoveryCodes.map(
          (recoveryCode) =>
            this.totpService
              .hashRecoveryCode(
                recoveryCode,
              ),
        ),
      );

    await this.authRepository
      .revokeAllSessionsExcept(
        user.id,
        organizationId,
        sessionId,
      );

    return {
      recoveryCodes,
    };
  }

  async logout(
    userId: string,
    sessionId: string,
  ) {
    await this.authRepository
      .revokeSessionForUser(
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
      await this.authRepository
        .revokeAllSessionsForUser(
          userId,
          organizationId,
        );

    return {
      success: true,
      revokedSessions:
        result.count,
    };
  }

  async listSessions(
    organizationId: string,
    currentSessionId: string,
  ) {
    const sessions =
      await this.authRepository
        .listSessions(
          organizationId,
        );

    const now = Date.now();

    return sessions.map(
      (session) => ({
        id: session.id,
        userId: session.userId,
        userName:
          session.user.name,
        userEmail:
          session.user.email,
        userRole:
          session.user.role,
        userStatus:
          session.user.status,
        ipAddress:
          session.ipAddress,
        userAgent:
          session.userAgent,
        createdAt:
          session.createdAt,
        lastUsedAt:
          session.lastUsedAt,
        expiresAt:
          session.expiresAt,
        revokedAt:
          session.revokedAt,
        current:
          session.id ===
          currentSessionId,
        state: session.revokedAt
          ? 'REVOKED'
          : session.expiresAt
                .getTime() <= now
            ? 'EXPIRED'
            : 'ACTIVE',
      }),
    );
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
      revokedSessions:
        result.count,
    };
  }

  private async verifyPasswordAndMfa(
    user: User,
    password: string,
    code: string,
  ): Promise<void> {
    if (
      !(await compare(
        password,
        user.passwordHash,
      )) ||
      !user.mfaEnabled ||
      !(await this.verifyMfaCode(
        user,
        code,
        true,
      ))
    ) {
      throw new UnauthorizedException(
        'Invalid password or authentication code',
      );
    }
  }

  private async verifyMfaCode(
    user: User,
    code: string,
    allowRecovery: boolean,
  ): Promise<boolean> {
    if (
      !user.mfaSecretEncrypted
    ) {
      return false;
    }

    const secret =
      this.totpService
        .decryptSecret(
          user.mfaSecretEncrypted,
        );

    if (
      this.totpService
        .verifyCode(
          secret,
          code,
        )
    ) {
      return true;
    }

    if (!allowRecovery) {
      return false;
    }

    const hashes =
      this.recoveryHashes(user);

    const index =
      hashes.findIndex(
        (storedHash) =>
          this.totpService
            .recoveryCodeMatches(
              code,
              storedHash,
            ),
      );

    if (index < 0) {
      return false;
    }

    await this.authRepository
      .replaceRecoveryCodes(
        user.id,
        hashes.filter(
          (_, itemIndex) =>
            itemIndex !== index,
        ),
      );

    return true;
  }

  private recoveryHashes(
    user: User,
  ): string[] {
    const value =
      user.mfaRecoveryCodeHashes;

    return Array.isArray(value)
      ? value.filter(
          (
            item,
          ): item is string =>
            typeof item ===
            'string',
        )
      : [];
  }

  private async createChallenge(
    user: User,
    stage: AuthChallengeStage,
    context: SessionContext,
  ): Promise<PendingAuthResult> {
    const challengeId =
      randomUUID();

    await this.authRepository
      .createChallenge({
        id: challengeId,
        organizationId:
          user.organizationId,
        userId: user.id,
        type: stage,
        ipAddress:
          context.ipAddress,
        userAgent:
          context.userAgent,
        expiresAt: new Date(
          Date.now() +
            5 * 60 * 1000,
        ),
      });

    const payload:
      AuthChallengePayload = {
        sub: user.id,
        cid: challengeId,
        jti: randomUUID(),
        stage,
        type: 'auth_challenge',
      };

    const challengeToken =
      await this.jwtService
        .signAsync(payload, {
          secret:
            this.accessSecret(),
          expiresIn: 300,
        });

    return {
      stage:
        stage ===
        'PASSWORD_CHANGE'
          ? 'PASSWORD_CHANGE_REQUIRED'
          : 'MFA_REQUIRED',
      challengeToken,
      user: {
        name: user.name,
        email: user.email,
      },
    };
  }

  private async resolveChallenge(
    token: string,
    stage: AuthChallengeStage,
  ) {
    let payload:
      AuthChallengePayload;

    try {
      payload =
        await this.jwtService
          .verifyAsync<AuthChallengePayload>(
            token,
            {
              secret:
                this.accessSecret(),
            },
          );
    } catch {
      throw new UnauthorizedException(
        'Authentication challenge is unavailable',
      );
    }

    if (
      payload.type !==
        'auth_challenge' ||
      payload.stage !== stage
    ) {
      throw new UnauthorizedException(
        'Authentication challenge is unavailable',
      );
    }

    const [user, challenge] =
      await Promise.all([
        this.authRepository
          .findActiveById(
            payload.sub,
          ),
        this.authRepository
          .findActiveChallenge(
            payload.cid,
            payload.sub,
            stage,
          ),
      ]);

    if (!user || !challenge) {
      throw new UnauthorizedException(
        'Authentication challenge is unavailable',
      );
    }

    return {
      user,
      challengeId:
        challenge.id,
    };
  }

  private async createSession(
    user: User,
    context: SessionContext,
  ): Promise<AuthenticatedAuthResult> {
    await this.authRepository
      .markLogin(user.id);

    const authUser =
      this.toAuthUser(user);

    const sessionId =
      randomUUID();

    const tokens =
      await this.issueTokens(
        authUser,
        sessionId,
      );

    await this.authRepository
      .createSession({
        id: sessionId,
        organizationId:
          user.organizationId,
        userId: user.id,
        refreshTokenHash:
          this.hashRefreshToken(
            tokens.refreshToken,
          ),
        ipAddress:
          context.ipAddress,
        userAgent:
          context.userAgent,
        expiresAt:
          this.refreshExpiresAt(),
      });

    return {
      stage: 'AUTHENTICATED',
      ...tokens,
      user: authUser,
    };
  }

  private async issueTokens(
    user: AuthUser,
    sessionId: string,
  ) {
    const accessPayload:
      JwtPayload = {
        sub: user.id,
        sid: sessionId,
        jti: randomUUID(),
        organizationId:
          user.organizationId,
        email: user.email,
        role: user.role,
        type: 'access',
      };

    const refreshPayload:
      RefreshJwtPayload = {
        sub: user.id,
        sid: sessionId,
        jti: randomUUID(),
        type: 'refresh',
      };

    const [
      accessToken,
      refreshToken,
    ] = await Promise.all([
      this.jwtService.signAsync(
        accessPayload,
        {
          secret:
            this.accessSecret(),
          expiresIn:
            this.accessExpiresSeconds(),
        },
      ),
      this.jwtService.signAsync(
        refreshPayload,
        {
          secret:
            this.refreshSecret(),
          expiresIn:
            this.refreshExpiresSeconds(),
        },
      ),
    ]);

    return {
      accessToken,
      refreshToken,
    };
  }

  private async requireUser(
    userId: string,
  ): Promise<User> {
    const user =
      await this.authRepository
        .findActiveById(userId);

    if (!user) {
      throw new UnauthorizedException(
        'Authentication required',
      );
    }

    return user;
  }

  private accessSecret(): string {
    return this.configService
      .getOrThrow<string>(
        'JWT_SECRET',
      );
  }

  private refreshSecret(): string {
    return this.configService
      .getOrThrow<string>(
        'JWT_REFRESH_SECRET',
      );
  }

  private accessExpiresSeconds():
  number {
    return Number(
      this.configService
        .get<string>(
          'JWT_EXPIRES_SECONDS',
        ) ?? 900,
    );
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

  private refreshExpiresAt(): Date {
    return new Date(
      Date.now() +
        this.refreshExpiresSeconds() *
          1000,
    );
  }

  private hashRefreshToken(
    token: string,
  ): string {
    return createHash('sha256')
      .update(token)
      .digest('hex');
  }

  private hashesMatch(
    first: string,
    second: string,
  ): boolean {
    const firstBuffer =
      Buffer.from(first);

    const secondBuffer =
      Buffer.from(second);

    return (
      firstBuffer.length ===
        secondBuffer.length &&
      timingSafeEqual(
        firstBuffer,
        secondBuffer,
      )
    );
  }

  private toAuthUser(
    user: User,
  ): AuthUser {
    return {
      id: user.id,
      organizationId:
        user.organizationId,
      name: user.name,
      email: user.email,
      role: user.role,
      mustChangePassword:
        user.mustChangePassword,
      mfaEnabled:
        user.mfaEnabled,
    };
  }
}
