import {
  deviceIngestionKeyPrefix,
  generateDeviceIngestionKey,
  hashDeviceIngestionKey,
  verifyDeviceIngestionKey,
} from './device-ingestion-key';

describe('device ingestion keys', () => {
  it('generates unique high-entropy keys', () => {
    const first = generateDeviceIngestionKey();
    const second = generateDeviceIngestionKey();

    expect(first).toMatch(
      /^psop_cam_[A-Za-z0-9_-]{43}$/,
    );
    expect(second).not.toBe(first);
  });

  it('hashes and verifies without raw-key storage', () => {
    const key = generateDeviceIngestionKey();
    const hash = hashDeviceIngestionKey(key);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      verifyDeviceIngestionKey(key, hash),
    ).toBe(true);
    expect(
      verifyDeviceIngestionKey(`${key}-wrong`, hash),
    ).toBe(false);
  });

  it('returns only a non-secret prefix', () => {
    const key = generateDeviceIngestionKey();
    const prefix = deviceIngestionKeyPrefix(key);

    expect(prefix).toHaveLength(16);
    expect(key.startsWith(prefix)).toBe(true);
  });
});
