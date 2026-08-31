import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const EDGE_AGENT_DELIVERY_STATES = [
  'DELIVERED',
  'BUFFERED',
  'ERROR',
] as const;

const COLLECTION_STATES = [
  'COMPLETE',
  'PARTIAL',
  'FAILED',
  'NOT_APPLICABLE',
] as const;

const REASON_SOURCES = [
  'DEVICE',
  'RECORDER',
  'GATEWAY',
  'ADAPTER',
  'API',
] as const;

const STORAGE_CAPABILITY_STATES = [
  'PRESENT',
  'NOT_INSTALLED',
  'UNKNOWN',
  'NOT_APPLICABLE',
] as const;

const RECORDING_CAPABILITY_STATES = [
  'AVAILABLE',
  'ABNORMAL',
  'NOT_AVAILABLE_NO_STORAGE',
  'UNKNOWN',
  'NOT_APPLICABLE',
] as const;

export class CollectionIssueDto {
  @IsString()
  @MaxLength(64)
  code!: string;

  @IsOptional()
  @IsIn(REASON_SOURCES)
  source?: (typeof REASON_SOURCES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  detail?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  channelNumber?: number;
}

class StorageCapabilityDto {
  @IsOptional()
  @IsBoolean()
  supported?: boolean;

  @IsOptional()
  @IsBoolean()
  present?: boolean;

  @IsOptional()
  @IsIn(STORAGE_CAPABILITY_STATES)
  state?: (typeof STORAGE_CAPABILITY_STATES)[number];
}

class RecordingCapabilityDto {
  @IsOptional()
  @IsIn(RECORDING_CAPABILITY_STATES)
  state?: (typeof RECORDING_CAPABILITY_STATES)[number];
}

export class OperationalCapabilitiesDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => StorageCapabilityDto)
  storage?: StorageCapabilityDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => RecordingCapabilityDto)
  recording?: RecordingCapabilityDto;
}

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
  @IsObject()
  details?: Record<string, unknown>;

  @IsOptional()
  @IsIn(COLLECTION_STATES)
  collectionState?: (typeof COLLECTION_STATES)[number];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => CollectionIssueDto)
  collectionIssues?: CollectionIssueDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => OperationalCapabilitiesDto)
  capabilities?: OperationalCapabilitiesDto;

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
