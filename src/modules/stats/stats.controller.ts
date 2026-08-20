import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import { StatsQueryDto } from './dto/stats-query.dto';

@ApiTags('Statistics')
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get overall statistics' })
  async getOverview(@Query() query: StatsQueryDto) {
    return this.statsService.getOverview(query);
  }

  @Get('messages')
  @ApiOperation({ summary: 'Get message statistics with time series' })
  async getMessageStats(@Query() query: StatsQueryDto) {
    return this.statsService.getMessageStats(query);
  }

  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Get statistics for a specific session' })
  async getSessionStats(@Param('sessionId') sessionId: string) {
    return this.statsService.getSessionStats(sessionId);
  }
}
