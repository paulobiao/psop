import { Injectable } from '@nestjs/common';
import { Site } from '../entities/site.entity';

@Injectable()
export class SiteRepository {
  async findAll(): Promise<Site[]> {
    return [];
  }
}
