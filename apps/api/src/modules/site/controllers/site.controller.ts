import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateSiteDto } from '../dto/create-site.dto';
import { UpdateSiteDto } from '../dto/update-site.dto';
import { SiteService } from '../services/site.service';

@Controller({
  path: 'sites',
  version: '1',
})
export class SiteController {
  constructor(private readonly siteService: SiteService) {}

  @Get()
  findAll() {
    return this.siteService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.siteService.findOne(id);
  }

  @Post()
  create(@Body() data: CreateSiteDto) {
    return this.siteService.create(data);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: UpdateSiteDto,
  ) {
    return this.siteService.update(id, data);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.siteService.remove(id);
  }
}
