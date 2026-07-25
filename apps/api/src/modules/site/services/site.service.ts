import { Injectable, NotFoundException } from '@nestjs/common';
import type { Site } from '../../../../generated/prisma/client.js';
import { CreateSiteDto } from '../dto/create-site.dto';
import { UpdateSiteDto } from '../dto/update-site.dto';
import { SiteRepository } from '../repositories/site.repository';

@Injectable()
export class SiteService {
  constructor(private readonly siteRepository: SiteRepository) {}

  async findAll(organizationId: string): Promise<Site[]> {
    return this.siteRepository.findAll(organizationId);
  }

  async findOne(
    organizationId: string,
    id: string,
  ): Promise<Site> {
    const site = await this.siteRepository.findById(
      id,
      organizationId,
    );

    if (!site) {
      throw new NotFoundException('Site not found');
    }

    return site;
  }

  async create(
    organizationId: string,
    data: CreateSiteDto,
  ): Promise<Site> {
    return this.siteRepository.create({
      ...data,
      organizationId,
    });
  }

  async update(
    organizationId: string,
    id: string,
    data: UpdateSiteDto,
  ): Promise<Site> {
    await this.findOne(organizationId, id);

    return this.siteRepository.update(id, data);
  }

  async remove(
    organizationId: string,
    id: string,
  ): Promise<Site> {
    await this.findOne(organizationId, id);

    return this.siteRepository.softDelete(id);
  }
}
