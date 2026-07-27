import {
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHmac,
} from 'node:crypto';
import { TotpService } from './totp.service';

const ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef' +
  '0123456789abcdef0123456789abcdef';

const RFC_SECRET =
  'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function createService(
  encryptionKey = ENCRYPTION_KEY,
): TotpService {
  const configService = {
    getOrThrow: jest
      .fn()
      .mockReturnValue(encryptionKey),
  } as unknown as ConfigService;

  return new TotpService(
    configService,
  );
}

function decodeBase32(
  value: string,
): Buffer {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  const normalized = value
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/\s/g, '');

  let bits = '';

  for (
    const character of normalized
  ) {
    const index =
      alphabet.indexOf(character);

    if (index < 0) {
      throw new Error(
        'Invalid Base32 test value',
      );
    }

    bits += index
      .toString(2)
      .padStart(5, '0');
  }

  const bytes: number[] = [];

  for (
    let index = 0;
    index + 8 <= bits.length;
    index += 8
  ) {
    bytes.push(
      Number.parseInt(
        bits.slice(
          index,
          index + 8,
        ),
        2,
      ),
    );
  }

  return Buffer.from(bytes);
}

function generateTotp(
  secret: string,
  counter: number,
): string {
  const buffer = Buffer.alloc(8);

  buffer.writeBigUInt64BE(
    BigInt(counter),
  );

  const digest = createHmac(
    'sha1',
    decodeBase32(secret),
  )
    .update(buffer)
    .digest();

  const offset =
    digest[digest.length - 1] &
    0x0f;

  const value =
    digest.readUInt32BE(offset) &
    0x7fffffff;

  return String(
    value % 1_000_000,
  ).padStart(6, '0');
}

function alterHexValue(
  value: string,
): string {
  const replacement =
    value[0] === '0'
      ? '1'
      : '0';

  return replacement +
    value.slice(1);
}

describe('TotpService', () => {
  let service: TotpService;

  beforeEach(() => {
    service = createService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('TOTP secrets', () => {
    it(
      'generates a 160-bit Base32 secret',
      () => {
        const secret =
          service.generateSecret();

        expect(secret).toMatch(
          /^[A-Z2-7]{32}$/,
        );

        expect(
          decodeBase32(secret),
        ).toHaveLength(20);
      },
    );

    it(
      'generates different secrets',
      () => {
        const first =
          service.generateSecret();

        const second =
          service.generateSecret();

        expect(second).not.toBe(
          first,
        );
      },
    );

    it(
      'creates a standards-compatible OTP URI',
      () => {
        const uri =
          service.createOtpAuthUri(
            'user+security@example.com',
            RFC_SECRET,
          );

        expect(uri).toBe(
          'otpauth://totp/' +
          'PSOP%3Auser%2Bsecurity%40example.com' +
          `?secret=${RFC_SECRET}` +
          '&issuer=PSOP' +
          '&algorithm=SHA1' +
          '&digits=6' +
          '&period=30',
        );
      },
    );
  });

  describe('TOTP verification', () => {
    it(
      'validates the RFC 6238 SHA-1 vector',
      () => {
        jest
          .spyOn(Date, 'now')
          .mockReturnValue(59_000);

        expect(
          service.verifyCode(
            RFC_SECRET,
            '287082',
          ),
        ).toBe(true);
      },
    );

    it(
      'accepts the current time window',
      () => {
        const timestamp =
          1_700_000_000_000;

        const counter = Math.floor(
          timestamp / 1000 / 30,
        );

        jest
          .spyOn(Date, 'now')
          .mockReturnValue(timestamp);

        const code = generateTotp(
          RFC_SECRET,
          counter,
        );

        expect(
          service.verifyCode(
            RFC_SECRET,
            code,
          ),
        ).toBe(true);
      },
    );

    it(
      'accepts one previous time window',
      () => {
        const timestamp =
          1_700_000_000_000;

        const counter = Math.floor(
          timestamp / 1000 / 30,
        );

        jest
          .spyOn(Date, 'now')
          .mockReturnValue(timestamp);

        const code = generateTotp(
          RFC_SECRET,
          counter - 1,
        );

        expect(
          service.verifyCode(
            RFC_SECRET,
            code,
          ),
        ).toBe(true);
      },
    );

    it(
      'accepts one following time window',
      () => {
        const timestamp =
          1_700_000_000_000;

        const counter = Math.floor(
          timestamp / 1000 / 30,
        );

        jest
          .spyOn(Date, 'now')
          .mockReturnValue(timestamp);

        const code = generateTotp(
          RFC_SECRET,
          counter + 1,
        );

        expect(
          service.verifyCode(
            RFC_SECRET,
            code,
          ),
        ).toBe(true);
      },
    );

    it(
      'rejects codes outside the allowed window',
      () => {
        const timestamp =
          1_700_000_000_000;

        const counter = Math.floor(
          timestamp / 1000 / 30,
        );

        jest
          .spyOn(Date, 'now')
          .mockReturnValue(timestamp);

        const oldCode = generateTotp(
          RFC_SECRET,
          counter - 2,
        );

        const futureCode =
          generateTotp(
            RFC_SECRET,
            counter + 2,
          );

        expect(
          service.verifyCode(
            RFC_SECRET,
            oldCode,
          ),
        ).toBe(false);

        expect(
          service.verifyCode(
            RFC_SECRET,
            futureCode,
          ),
        ).toBe(false);
      },
    );

    it.each([
      '',
      '12345',
      '1234567',
      'ABCDEF',
      '12-34-56',
      '000 000',
    ])(
      'rejects invalid code format: %s',
      (code) => {
        expect(
          service.verifyCode(
            RFC_SECRET,
            code,
          ),
        ).toBe(false);
      },
    );

    it(
      'ignores surrounding whitespace in a valid code',
      () => {
        jest
          .spyOn(Date, 'now')
          .mockReturnValue(59_000);

        expect(
          service.verifyCode(
            RFC_SECRET,
            ' 287082 ',
          ),
        ).toBe(true);
      },
    );
  });

  describe('secret encryption', () => {
    it(
      'encrypts and decrypts a TOTP secret',
      () => {
        const encrypted =
          service.encryptSecret(
            RFC_SECRET,
          );

        expect(encrypted).not.toContain(
          RFC_SECRET,
        );

        expect(
          encrypted.split(':'),
        ).toHaveLength(3);

        expect(
          service.decryptSecret(
            encrypted,
          ),
        ).toBe(RFC_SECRET);
      },
    );

    it(
      'uses a different IV for each encryption',
      () => {
        const first =
          service.encryptSecret(
            RFC_SECRET,
          );

        const second =
          service.encryptSecret(
            RFC_SECRET,
          );

        expect(second).not.toBe(first);

        expect(
          service.decryptSecret(first),
        ).toBe(RFC_SECRET);

        expect(
          service.decryptSecret(second),
        ).toBe(RFC_SECRET);
      },
    );

    it(
      'rejects malformed encrypted storage',
      () => {
        expect(() =>
          service.decryptSecret(
            'invalid-value',
          ),
        ).toThrow(
          InternalServerErrorException,
        );
      },
    );

    it(
      'rejects an altered authentication tag',
      () => {
        const encrypted =
          service.encryptSecret(
            RFC_SECRET,
          );

        const [
          iv,
          tag,
          ciphertext,
        ] = encrypted.split(':');

        const altered = [
          iv,
          alterHexValue(tag),
          ciphertext,
        ].join(':');

        expect(() =>
          service.decryptSecret(
            altered,
          ),
        ).toThrow();
      },
    );

    it(
      'rejects altered ciphertext',
      () => {
        const encrypted =
          service.encryptSecret(
            RFC_SECRET,
          );

        const [
          iv,
          tag,
          ciphertext,
        ] = encrypted.split(':');

        const altered = [
          iv,
          tag,
          alterHexValue(ciphertext),
        ].join(':');

        expect(() =>
          service.decryptSecret(
            altered,
          ),
        ).toThrow();
      },
    );

    it(
      'rejects an encryption key with an invalid size',
      () => {
        const invalidService =
          createService('abcd');

        expect(() =>
          invalidService.encryptSecret(
            RFC_SECRET,
          ),
        ).toThrow(
          InternalServerErrorException,
        );
      },
    );
  });

  describe('recovery codes', () => {
    it(
      'generates ten unique recovery codes by default',
      () => {
        const codes =
          service.generateRecoveryCodes();

        expect(codes).toHaveLength(10);

        expect(
          new Set(codes).size,
        ).toBe(10);

        for (const code of codes) {
          expect(code).toMatch(
            /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/,
          );
        }
      },
    );

    it(
      'supports a custom recovery-code count',
      () => {
        expect(
          service.generateRecoveryCodes(
            4,
          ),
        ).toHaveLength(4);
      },
    );

    it(
      'hashes recovery codes without storing plaintext',
      () => {
        const code = 'ABCD-2345';

        const hash =
          service.hashRecoveryCode(
            code,
          );

        expect(hash).toMatch(
          /^[a-f0-9]{64}$/,
        );

        expect(hash).not.toContain(
          code,
        );
      },
    );

    it(
      'normalizes case, spaces and separators',
      () => {
        const hash =
          service.hashRecoveryCode(
            'ABCD-2345',
          );

        expect(
          service.recoveryCodeMatches(
            'abcd 2345',
            hash,
          ),
        ).toBe(true);

        expect(
          service.recoveryCodeMatches(
            'abcd_2345',
            hash,
          ),
        ).toBe(true);
      },
    );

    it(
      'rejects a different recovery code',
      () => {
        const hash =
          service.hashRecoveryCode(
            'ABCD-2345',
          );

        expect(
          service.recoveryCodeMatches(
            'ABCD-2346',
            hash,
          ),
        ).toBe(false);
      },
    );

    it(
      'produces different hashes for different codes',
      () => {
        const first =
          service.hashRecoveryCode(
            'ABCD-2345',
          );

        const second =
          service.hashRecoveryCode(
            'WXYZ-6789',
          );

        expect(second).not.toBe(first);
      },
    );
  });
});
