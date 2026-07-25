import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  User,
} from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';

@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(organizationId: string): Promise<User[]> {
    return this.prisma.user.findMany({
      where: {
        organizationId,
        deletedAt: null,
      },
      orderBy: [
        {
          status: 'asc',
        },
        {
          name: 'asc',
        },
      ],
    });
  }

  findById(
    id: string,
    organizationId: string,
  ): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: {
        id,
        organizationId,
        deletedAt: null,
      },
    });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: {
        email,
      },
    });
  }

  create(
    data: Prisma.UserUncheckedCreateInput,
  ): Promise<User> {
    return this.prisma.user.create({
      data,
    });
  }

  update(
    id: string,
    data: Prisma.UserUncheckedUpdateInput,
  ): Promise<User> {
    return this.prisma.user.update({
      where: {
        id,
      },
      data,
    });
  }

  countActiveAdmins(
    organizationId: string,
  ): Promise<number> {
    return this.prisma.user.count({
      where: {
        organizationId,
        role: 'ADMIN',
        status: 'ACTIVE',
        deletedAt: null,
      },
    });
  }

  softDelete(id: string): Promise<User> {
    return this.prisma.user.update({
      where: {
        id,
      },
      data: {
        status: 'DISABLED',
        deletedAt: new Date(),
      },
    });
  }
}
