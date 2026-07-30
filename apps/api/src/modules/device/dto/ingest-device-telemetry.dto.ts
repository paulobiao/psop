import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class IngestDeviceTelemetryDto {
  @IsInt()
  @Min(0)
  timestamp!: number;

  @IsString()
  @MaxLength(64)
  status!: string;

  @IsOptional()
  @IsNumber()
  @Min(-100)
  @Max(200)
  temperatureC?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  bitrateKbps?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  storageUsedPct?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  uptimeSeconds?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  firmware?: string;
}
