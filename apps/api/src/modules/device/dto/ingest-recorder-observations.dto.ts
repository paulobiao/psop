import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class RecorderObservedDeviceDto {
  @IsUUID()
  deviceId!: string;

  @IsIn([
    'online',
    'offline',
    'warning',
    'unknown',
  ])
  status!:
    | 'online'
    | 'offline'
    | 'warning'
    | 'unknown';

  @IsOptional()
  @IsString()
  @MaxLength(160)
  channelId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  channelNumber?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  poePort?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  poePowerW?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  recordingStatus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  protocol?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  bitrateKbps?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  resolution?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  frameRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  firmware?: string;
}

export class IngestRecorderObservationsDto {
  @IsInt()
  @Min(0)
  timestamp!: number;

  @ValidateNested({ each: true })
  @Type(() => RecorderObservedDeviceDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(128)
  observations!: RecorderObservedDeviceDto[];
}
