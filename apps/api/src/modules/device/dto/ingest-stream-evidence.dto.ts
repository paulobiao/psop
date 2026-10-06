import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsIP,
  IsOptional,
  IsObject,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export const STREAM_LEVELS = [
  'E4_STREAM_URI_OBTAINED',
  'E5_RTSP_SESSION_NEGOTIATED',
  'E6_FRAMES_RECEIVED',
] as const;
export const STREAM_RESULTS = [
  'SUCCEEDED',
  'UNKNOWN',
  'NOT_OBSERVED',
  'UNSUPPORTED',
  'FAILED',
] as const;

// No raw URI, path, query, session ID, headers, diagnostic text or credentials.
export class StreamEndpointDto {
  @IsIn(['rtsp', 'rtsps']) protocol!: 'rtsp' | 'rtsps';
  @IsIP() host!: string;
  @IsInt() @Min(1) @Max(65535) port!: number;
  @Matches(/^[a-f0-9]{64}$/) pathSha256!: string;
  // Required for discovered endpoints; a manual URI has no discovered profile.
  @IsOptional() @Matches(/^[a-f0-9]{64}$/) profileSha256?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) channelNumber?: number;
  // MANUAL_OPERATOR_INPUT: URI copied by an operator, never discovered (no E4).
  @IsIn(['ONVIF_GET_STREAM_URI', 'VENDOR_API', 'MANUAL_OPERATOR_INPUT'])
  discoveryMethod!:
    'ONVIF_GET_STREAM_URI' | 'VENDOR_API' | 'MANUAL_OPERATOR_INPUT';
  // NVR_MEDIATED: the recorder served the stream; not a direct camera observation.
  @IsOptional() @IsIn(['DIRECT', 'NVR_MEDIATED']) access?:
    'DIRECT' | 'NVR_MEDIATED';
}

/** E5: matching DESCRIBE 200 with SDP video selection, SETUP 200 establishing
 * transport/session, then PLAY 200 for that same session. OPTIONS/TCP alone
 * never qualify. Raw Session headers and SDP must stay at the probe. */
export class RtspNegotiationDto {
  @IsIn([200]) describeStatus!: 200;
  @IsIn([200]) setupStatus!: 200;
  @IsIn([200]) playStatus!: 200;
  @IsIn([true]) videoTrackSelected!: true;
  @IsIn([true]) sessionEstablished!: true;
  @IsIn(['RTP_AVP_TCP', 'RTP_AVP_UDP']) transport!:
    'RTP_AVP_TCP' | 'RTP_AVP_UDP';
}

export class ReceivedMediaDto {
  @IsIn(['RTP_VIDEO_PACKETS', 'DECODED_VIDEO_FRAMES']) measurement!:
    'RTP_VIDEO_PACKETS' | 'DECODED_VIDEO_FRAMES';
  @IsInt() @Min(1) @Max(10000000) count!: number;
  @IsInt() @Min(1) @Max(60000) windowMs!: number;
  @Matches(TIMESTAMP)
  @IsISO8601({ strict: true })
  lastReceivedAt!: string;
}

export class IngestStreamEvidenceDto {
  @IsUUID() deviceId!: string;
  // UUID identifies the probe installation; authenticated device is its principal.
  @IsUUID() probeId!: string;
  @IsUUID() sourceEventKey!: string;
  // Groups the per-level rows of one probe run (required for NVR_MEDIATED).
  @IsOptional() @IsUUID() attemptId?: string;
  @IsIn(STREAM_LEVELS) level!: (typeof STREAM_LEVELS)[number];
  @IsIn(STREAM_RESULTS) result!: (typeof STREAM_RESULTS)[number];
  @IsIn(['ADAPTER', 'GATEWAY', 'DEVICE']) source!:
    'ADAPTER' | 'GATEWAY' | 'DEVICE';
  @Matches(TIMESTAMP)
  @IsISO8601({ strict: true })
  observedAt!: string;
  @Matches(TIMESTAMP)
  @IsISO8601({ strict: true })
  expiresAt!: string;
  @IsIn([
    'NONE',
    'AUTHENTICATION_FAILED',
    'UNREACHABLE',
    'TIMEOUT',
    'PROTOCOL_ERROR',
    'CAPABILITY_UNAVAILABLE',
    'NOT_ATTEMPTED',
    'UNKNOWN',
  ])
  reason!:
    | 'NONE'
    | 'AUTHENTICATION_FAILED'
    | 'UNREACHABLE'
    | 'TIMEOUT'
    | 'PROTOCOL_ERROR'
    | 'CAPABILITY_UNAVAILABLE'
    | 'NOT_ATTEMPTED'
    | 'UNKNOWN';
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => StreamEndpointDto)
  endpoint?: StreamEndpointDto;
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RtspNegotiationDto)
  negotiation?: RtspNegotiationDto;
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ReceivedMediaDto)
  media?: ReceivedMediaDto;
}
