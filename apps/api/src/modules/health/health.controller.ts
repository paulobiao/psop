import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';

@Public()
@Controller({
  path: 'health',
  version: '1',
})
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      service: 'psop-api',
      timestamp: new Date().toISOString(),
    };
  }
}
