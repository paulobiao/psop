import { Injectable } from '@nestjs/common';
import type { Site } from '../../../../generated/prisma/client.js';
import { SiteRepository } from '../repositories/site.repository';

@Injectable()
export class SiteService {
  constructor(private readonly siteRepository: SiteRepository) {}

  async findAll(): Promise<Site[]> {
    return this.siteRepository.findAll();
  }
}
