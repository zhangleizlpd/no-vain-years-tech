import { Controller, Get, Query } from '@nestjs/common';
import { AppService } from './app.service';
import { HelloDto } from './hello.dto';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getData() {
    return this.appService.getData();
  }

  @Get('hello')
  hello(@Query() query: HelloDto) {
    return { hello: query.name };
  }
}
