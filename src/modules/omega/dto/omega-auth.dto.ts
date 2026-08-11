import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class OmegaLoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}

export class UpdateOmegaProfileDto {
  @IsString()
  fullName: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsBoolean()
  isOnDuty?: boolean;
}
