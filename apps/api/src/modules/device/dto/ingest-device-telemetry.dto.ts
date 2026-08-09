import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const EDGE_AGENT_DELIVERY_STATES = [
  'DELIVERED',
  'BUFFERED',
  'ERROR',
] as const;

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

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentVersion?: string;

  @IsOptional()
  @IsISO8601()
  runtimeStartedAt?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  runtimeUptimeSeconds?: number;

  @IsOptional()
  @IsIn(EDGE_AGENT_DELIVERY_STATES)
  previousDeliveryState?:
    (typeof EDGE_AGENT_DELIVERY_STATES)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  pendingBufferCount?: number;

  @IsOptional()
  @IsISO8601()
  lastSuccessfulDeliveryAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  lastDeliveryError?: string;

  @IsOptional()
  @IsISO8601()
  lastDeliveryErrorAt?: string;
}
