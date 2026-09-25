import type { IngestStreamEvidenceDto } from '../dto/ingest-stream-evidence.dto.js';
export function streamFixture(): IngestStreamEvidenceDto {
  return {
    deviceId: '11111111-1111-4111-8111-111111111111',
    probeId: '22222222-2222-4222-8222-222222222222',
    sourceEventKey: '33333333-3333-4333-8333-333333333333',
    level: 'E4_STREAM_URI_OBTAINED',
    result: 'SUCCEEDED',
    source: 'ADAPTER',
    reason: 'NONE',
    observedAt: '2026-09-01T12:00:00.000Z',
    expiresAt: '2026-09-01T12:02:00.000Z',
    endpoint: {
      protocol: 'rtsp',
      host: '192.0.2.1',
      port: 554,
      pathSha256: 'a'.repeat(64),
      profileSha256: 'b'.repeat(64),
      discoveryMethod: 'ONVIF_GET_STREAM_URI',
      channelNumber: 1,
    },
  };
}
export const negotiation = {
  describeStatus: 200,
  setupStatus: 200,
  playStatus: 200,
  videoTrackSelected: true,
  sessionEstablished: true,
  transport: 'RTP_AVP_TCP',
} as const;
