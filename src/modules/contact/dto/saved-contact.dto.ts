import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class SavedContactItemDto {
  @ApiPropertyOptional({ description: 'Display name for the contact' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: 'Phone number or WhatsApp identifier', example: '+15551234567' })
  @IsString()
  number: string;

  @ApiPropertyOptional({ description: 'Where this contact came from', enum: ['imported', 'session'], default: 'imported' })
  @IsOptional()
  @IsIn(['imported', 'session'])
  source?: 'imported' | 'session';
}

export class SaveContactsDto {
  @ApiProperty({ type: [SavedContactItemDto], description: 'Contacts to save for the selected session' })
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => SavedContactItemDto)
  contacts: SavedContactItemDto[];
}
