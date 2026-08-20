import { IsIn, IsISO8601, IsOptional } from 'class-validator';

export class StatsQueryDto {
  @IsOptional()
  @IsIn(['today', '7d', '30d', 'custom'])
  period?: 'today' | '7d' | '30d' | 'custom' = 'today';

  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @IsOptional()
  @IsISO8601()
  endDate?: string;
}
