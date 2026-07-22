import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreateSiteDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE', 'MAINTENANCE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE' | 'ARCHIVED';
}
