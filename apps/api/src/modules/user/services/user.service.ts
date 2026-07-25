import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import type { User } from '../../../../generated/prisma/client.js';
import { ChangeUserPasswordDto } from '../dto/change-user-password.dto.js';
import { CreateUserDto } from '../dto/create-user.dto.js';
import { UpdateUserDto } from '../dto/update-user.dto.js';
import { UserRepository } from '../repositories/user.repository.js';

@Injectable()
export class UserService {
  constructor(
    private readonly userRepository: UserRepository,
  ) {}

  async findAll(organizationId: string) {
    const users =
      await this.userRepository.findAll(organizationId);

    return users.map((user) => this.toPublicUser(user));
  }

  async findOne(
    organizationId: string,
    id: string,
  ) {
    const user = await this.requireUser(
      organizationId,
      id,
    );

    return this.toPublicUser(user);
  }

  async create(
    organizationId: string,
    data: CreateUserDto,
  ) {
    const email = data.email.trim().toLowerCase();

    await this.ensureEmailAvailable(email);

    const user = await this.userRepository.create({
      organizationId,
      name: data.name.trim(),
      email,
      passwordHash: await hash(data.password, 12),
      role: data.role,
      status: 'ACTIVE',
    });

    return this.toPublicUser(user);
  }

  async update(
    organizationId: string,
    currentUserId: string,
    id: string,
    data: UpdateUserDto,
  ) {
    const user = await this.requireUser(
      organizationId,
      id,
    );

    if (
      id === currentUserId &&
      data.status === 'DISABLED'
    ) {
      throw new BadRequestException(
        'You cannot disable your own account',
      );
    }

    if (
      id === currentUserId &&
      data.role &&
      data.role !== 'ADMIN'
    ) {
      throw new BadRequestException(
        'You cannot remove your own administrator role',
      );
    }

    await this.ensureAdminRemains(
      organizationId,
      user,
      data.role,
      data.status,
    );

    let email: string | undefined;

    if (data.email) {
      email = data.email.trim().toLowerCase();

      if (email !== user.email) {
        await this.ensureEmailAvailable(email);
      }
    }

    const updated = await this.userRepository.update(
      id,
      {
        ...(data.name
          ? { name: data.name.trim() }
          : {}),
        ...(email ? { email } : {}),
        ...(data.role ? { role: data.role } : {}),
        ...(data.status
          ? { status: data.status }
          : {}),
      },
    );

    return this.toPublicUser(updated);
  }

  async changePassword(
    organizationId: string,
    id: string,
    data: ChangeUserPasswordDto,
  ) {
    await this.requireUser(organizationId, id);

    const updated = await this.userRepository.update(
      id,
      {
        passwordHash: await hash(data.password, 12),
      },
    );

    return this.toPublicUser(updated);
  }

  async remove(
    organizationId: string,
    currentUserId: string,
    id: string,
  ) {
    const user = await this.requireUser(
      organizationId,
      id,
    );

    if (id === currentUserId) {
      throw new BadRequestException(
        'You cannot remove your own account',
      );
    }

    await this.ensureAdminRemains(
      organizationId,
      user,
      user.role,
      'DISABLED',
    );

    const removed =
      await this.userRepository.softDelete(id);

    return this.toPublicUser(removed);
  }

  private async requireUser(
    organizationId: string,
    id: string,
  ): Promise<User> {
    const user = await this.userRepository.findById(
      id,
      organizationId,
    );

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  private async ensureEmailAvailable(
    email: string,
  ): Promise<void> {
    const existing =
      await this.userRepository.findByEmail(email);

    if (existing) {
      throw new ConflictException(
        'Email address is already in use',
      );
    }
  }

  private async ensureAdminRemains(
    organizationId: string,
    user: User,
    nextRole?: 'ADMIN' | 'OPERATOR' | 'VIEWER',
    nextStatus?: 'ACTIVE' | 'DISABLED',
  ): Promise<void> {
    if (
      user.role !== 'ADMIN' ||
      user.status !== 'ACTIVE'
    ) {
      return;
    }

    const removesActiveAdmin =
      (nextRole && nextRole !== 'ADMIN') ||
      nextStatus === 'DISABLED';

    if (!removesActiveAdmin) {
      return;
    }

    const activeAdmins =
      await this.userRepository.countActiveAdmins(
        organizationId,
      );

    if (activeAdmins <= 1) {
      throw new BadRequestException(
        'The organization must keep at least one active administrator',
      );
    }
  }

  private toPublicUser(user: User) {
    return {
      id: user.id,
      organizationId: user.organizationId,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
