import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function generateDeviceIngestionKey(): string {
  return `psop_cam_${randomBytes(32).toString('base64url')}`;
}

export function hashDeviceIngestionKey(
  key: string,
): string {
  return createHash('sha256').update(key).digest('hex');
}

export function deviceIngestionKeyPrefix(
  key: string,
): string {
  return key.slice(0, 16);
}

export function verifyDeviceIngestionKey(
  key: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(
    hashDeviceIngestionKey(key),
    'hex',
  );
  const expected = Buffer.from(expectedHash, 'hex');

  return (
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}
