import { validateStreamEvidence } from './stream-evidence.js';

import { streamFixture, negotiation } from './stream-evidence.fixture.js';

describe('stream evidence contract', () => {
  it.each([
    'E4_STREAM_URI_OBTAINED',
    'E5_RTSP_SESSION_NEGOTIATED',
    'E6_FRAMES_RECEIVED',
  ] as const)('accepts distinct proof for %s', (level) => {
    const value = streamFixture();
    value.level = level;
    if (level !== 'E4_STREAM_URI_OBTAINED') value.negotiation = negotiation;
    if (level === 'E6_FRAMES_RECEIVED')
      value.media = {
        measurement: 'RTP_VIDEO_PACKETS',
        count: 3,
        windowMs: 1000,
        lastReceivedAt: value.observedAt,
      };
    expect(validateStreamEvidence(value)).toEqual(value);
  });
  it.each([
    ['FAILED', 'AUTHENTICATION_FAILED'],
    ['FAILED', 'UNREACHABLE'],
    ['UNSUPPORTED', 'CAPABILITY_UNAVAILABLE'],
    ['NOT_OBSERVED', 'NOT_ATTEMPTED'],
    ['UNKNOWN', 'UNKNOWN'],
  ] as const)('preserves %s / %s without positive proof', (result, reason) => {
    const value = {
      ...streamFixture(),
      result,
      reason,
      endpoint: undefined,
      level: 'E6_FRAMES_RECEIVED' as const,
    };
    expect(validateStreamEvidence(value).result).toBe(result);
  });
  it.each([
    { observedAt: 'invalid' },
    { observedAt: '2026-09-01' },
    { observedAt: '2026-09-01T12:00:00' },
    { endpoint: [] },
    { level: 'E5_RTSP_SESSION_NEGOTIATED', negotiation: [] },
    { expiresAt: '2026-09-01T12:00:00Z' },
    { expiresAt: '2026-09-01T12:03:00Z' },
    { observedAt: '2099-01-01T00:00:00Z' },
    { result: 'STALE' },
    { result: 'FAILED' },
    { endpoint: null },
    { level: 'E5_RTSP_SESSION_NEGOTIATED' },
    { level: 'E6_FRAMES_RECEIVED', negotiation },
    { uri: 'rtsp://user:secret@192.0.2.1/private?token=secret' },
    { details: { frameRate: 30 } },
    { probeId: 'secret' },
    { reason: 'x'.repeat(4097) },
  ])('rejects malformed or unsupported claims %#', (patch) => {
    expect(() =>
      validateStreamEvidence({ ...streamFixture(), ...patch } as never),
    ).toThrow('Invalid stream evidence');
  });
  it.each([
    { port: 0 },
    { port: 65536 },
    { host: 'user:secret@192.0.2.1' },
    { host: 'token.example.test' },
    { pathSha256: '/secret' },
    { password: 'secret' },
    { discoveryMethod: 'CONFIGURED' },
    { channelNumber: -1 },
  ])('rejects unsafe endpoint %#', (patch) => {
    const input = streamFixture();
    input.endpoint = { ...input.endpoint!, ...patch } as never;
    expect(() => validateStreamEvidence(input)).toThrow(
      'Invalid stream evidence',
    );
  });
  it('rejects authentication failure claimed as negotiation success', () => {
    expect(() =>
      validateStreamEvidence({
        ...streamFixture(),
        level: 'E5_RTSP_SESSION_NEGOTIATED',
        negotiation: { ...negotiation, setupStatus: 401 },
      } as never),
    ).toThrow();
  });
  it.each([0, -1, 10000001])('rejects invalid media count %s', (count) => {
    expect(() =>
      validateStreamEvidence({
        ...streamFixture(),
        level: 'E6_FRAMES_RECEIVED',
        negotiation,
        media: {
          measurement: 'DECODED_VIDEO_FRAMES',
          count,
          windowMs: 1000,
          lastReceivedAt: streamFixture().observedAt,
        },
      }),
    ).toThrow();
  });
  it('rejects old media even when an observation is fresh', () => {
    expect(() =>
      validateStreamEvidence({
        ...streamFixture(),
        level: 'E6_FRAMES_RECEIVED',
        negotiation,
        media: {
          measurement: 'RTP_VIDEO_PACKETS',
          count: 1,
          windowMs: 1000,
          lastReceivedAt: '2026-09-01T11:59:58Z',
        },
      }),
    ).toThrow();
  });
});
