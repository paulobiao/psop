import {
  IsIn,
  IsInt,
  IsIP,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateDeviceDto {
  @IsUUID()
  siteId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  externalId!: string;

  @IsIn([
    'CAMERA',
    'RECORDER',
    'GATEWAY',
    'ACCESS_CONTROLLER',
    'SENSOR',
    'INTERCOM',
    'NETWORK_SWITCH',
  ])
  deviceType!:
    | 'CAMERA'
    | 'RECORDER'
    | 'GATEWAY'
    | 'ACCESS_CONTROLLER'
    | 'SENSOR'
    | 'INTERCOM'
    | 'NETWORK_SWITCH';

  @IsOptional()
  @IsString()
  manufacturer?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  firmwareVersion?: string;

  @IsOptional()
  @IsIP()
  ipAddress?: string;

  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE', 'MAINTENANCE', 'DECOMMISSIONED'])
  status?: 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE' | 'DECOMMISSIONED';

  @IsOptional()
  @IsInt()
  @Min(5)
  expectedHeartbeatInterval?: number;
}
