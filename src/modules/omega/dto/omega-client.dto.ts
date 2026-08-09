import { IsEmail, IsEnum, IsInt, IsOptional, IsPhoneNumber, IsString, Min } from 'class-validator';
import { OmegaClientStatus } from '../entities';

export class CreateOmegaClientDto {
  @IsString()
  companyName: string;

  @IsString()
  ownerName: string;

  @IsEmail()
  email: string;

  @IsString()
  phone: string;

  @IsOptional()
  @IsEnum(OmegaClientStatus)
  status?: OmegaClientStatus;

  @IsOptional()
  @IsString()
  planId?: string;

  @IsInt()
  @Min(0)
  monthlyMessageLimit: number;

  @IsInt()
  @Min(1)
  whatsappAccountLimit: number;
}

export class UpdateOmegaClientDto {
  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsString()
  ownerName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEnum(OmegaClientStatus)
  status?: OmegaClientStatus;

  @IsOptional()
  @IsString()
  planId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyMessageLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  whatsappAccountLimit?: number;
}
