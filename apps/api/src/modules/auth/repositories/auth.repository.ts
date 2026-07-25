import { Injectable } from '@nestjs/common';
import type { User } from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActiveByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: {
        email,
        status: 'ACTIVE',
        deletedAt: null,
        organization: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      },
    });
  }

  findActiveById(id: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: {
        id,
        status: 'ACTIVE',
        deletedAt: null,
        organization: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      },
    });
  }

  markLogin(id: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: {
        lastLoginAt: new Date(),
      },
    });
  }
}
