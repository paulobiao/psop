import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { IngestStreamEvidenceDto } from '../dto/ingest-stream-evidence.dto.js';

/** Validate even when called outside the HTTP pipeline. Never echo input/errors. */
export function validateStreamEvidence(
  input: IngestStreamEvidenceDto,
  now = Date.now(),
): IngestStreamEvidenceDto {
  const reject = (): never => {
    throw new BadRequestException('Invalid stream evidence');
  };
  if (!input || Buffer.byteLength(JSON.stringify(input), 'utf8') > 4096)
    reject();
  const value = plainToInstance(IngestStreamEvidenceDto, input);
  if (
    validateSync(value, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }).length
  )
    reject();
  const observed = Date.parse(value.observedAt);
  const expires = Date.parse(value.expiresAt);
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(expires) ||
    observed < 0 ||
    observed > now + 300000 ||
    expires <= observed ||
    expires - observed > 120000
  )
    reject();
  const success = value.result === 'SUCCEEDED';
  const allowedReasons = {
    SUCCEEDED: ['NONE'],
    UNKNOWN: ['UNKNOWN'],
    NOT_OBSERVED: ['NOT_ATTEMPTED'],
    UNSUPPORTED: ['CAPABILITY_UNAVAILABLE'],
    FAILED: [
      'AUTHENTICATION_FAILED',
      'UNREACHABLE',
      'TIMEOUT',
      'PROTOCOL_ERROR',
    ],
  };
  if (!allowedReasons[value.result].includes(value.reason)) reject();
  if (!success && (value.negotiation || value.media)) reject();
  if (success && !value.endpoint) reject();
  if (success && value.level !== 'E4_STREAM_URI_OBTAINED' && !value.negotiation)
    reject();
  if (
    value.level === 'E4_STREAM_URI_OBTAINED' &&
    (value.negotiation || value.media)
  )
    reject();
  if (value.level !== 'E6_FRAMES_RECEIVED' && value.media) reject();
  if (success && value.level === 'E6_FRAMES_RECEIVED' && !value.media) reject();
  if (value.media) {
    const last = Date.parse(value.media.lastReceivedAt);
    if (
      !Number.isFinite(last) ||
      last > observed ||
      last < observed - value.media.windowMs
    )
      reject();
  }
  return value;
}

// Preserve the existing database/API enum names, without rewriting historical rows.
export const STREAM_LEDGER_LEVEL = {
  E4_STREAM_URI_OBTAINED: 'E4_STREAM_URI_OBTAINED',
  E5_RTSP_SESSION_NEGOTIATED: 'E5_SESSION_NEGOTIATED',
  E6_FRAMES_RECEIVED: 'E6_MEDIA_RECEIVED',
} as const;
