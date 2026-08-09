import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class AssignOmegaSessionDto {
  @IsOptional()
  @IsString()
  clientId?: string | null;

  @IsOptional()
  @IsBoolean()
  overrideLimit?: boolean;
}

export class UpdateOmegaSessionReplacementDto {
  @IsBoolean()
  replacementRequested: boolean;
}
