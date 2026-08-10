import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export class UpdateNotificationPolicyDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(['WARNING', 'CRITICAL'])
  minimumSeverity?:
    | 'WARNING'
    | 'CRITICAL';

  @IsOptional()
  @IsBoolean()
  notifyOnRecovery?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyAdmins?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyOperators?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsEmail({}, { each: true })
  explicitEmails?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  cooldownMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  escalationDelayMinutes?: number;
}
