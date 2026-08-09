import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { OmegaUserRole, OmegaUserStatus } from '../entities';

export class CreateOmegaUserDto {
  @IsString()
  fullName: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsEnum(OmegaUserRole)
  role: OmegaUserRole;

  @IsOptional()
  @IsString()
  clientId?: string | null;
}

export class UpdateOmegaUserDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsEnum(OmegaUserRole)
  role?: OmegaUserRole;

  @IsOptional()
  @IsEnum(OmegaUserStatus)
  status?: OmegaUserStatus;

  @IsOptional()
  @IsString()
  clientId?: string | null;
}
