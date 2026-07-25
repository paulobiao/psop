import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import type { User } from '../../../../generated/prisma/client.js';
import type {
  AuthUser,
  JwtPayload,
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

  async login(data: LoginDto) {
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

    const payload: JwtPayload = {
      sub: authUser.id,
      organizationId: authUser.organizationId,
      email: authUser.email,
      role: authUser.role,
    };

    const accessToken = await this.jwtService.signAsync(
      payload,
      {
        secret:
          this.configService.getOrThrow<string>(
            'JWT_SECRET',
          ),
        expiresIn: Number(
          this.configService.get<string>(
            'JWT_EXPIRES_SECONDS',
          ) ?? 43200,
        ),
      },
    );

    return {
      accessToken,
      user: authUser,
    };
  }

  async validateUser(userId: string): Promise<AuthUser> {
    const user =
      await this.authRepository.findActiveById(userId);

    if (!user) {
      throw new UnauthorizedException(
        'Authentication required',
      );
    }

    return this.toAuthUser(user);
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
