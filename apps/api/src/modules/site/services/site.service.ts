import { Injectable, NotFoundException } from '@nestjs/common';
import type { Site } from '../../../../generated/prisma/client.js';
import { CreateSiteDto } from '../dto/create-site.dto';
import { UpdateSiteDto } from '../dto/update-site.dto';
import { SiteRepository } from '../repositories/site.repository';

@Injectable()
export class SiteService {
  constructor(private readonly siteRepository: SiteRepository) {}

  async findAll(): Promise<Site[]> {
    return this.siteRepository.findAll();
  }

  async findOne(id: string): Promise<Site> {
    const site = await this.siteRepository.findById(id);

    if (!site) {
      throw new NotFoundException('Site not found');
    }

    return site;
  }

  async create(data: CreateSiteDto): Promise<Site> {
    return this.siteRepository.create(data);
  }

  async update(id: string, data: UpdateSiteDto): Promise<Site> {
    await this.findOne(id);
    return this.siteRepository.update(id, data);
  }

  async remove(id: string): Promise<Site> {
    await this.findOne(id);
    return this.siteRepository.softDelete(id);
  }
}
