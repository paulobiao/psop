import {
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

@Injectable()
export class TotpService {
  private readonly alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  private readonly recoveryAlphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  constructor(
    private readonly configService:
      ConfigService,
  ) {}

  generateSecret(): string {
    return this.base32Encode(
      randomBytes(20),
    );
  }

  createOtpAuthUri(
    email: string,
    secret: string,
  ): string {
    const label = encodeURIComponent(
      `PSOP:${email}`,
    );

    const issuer =
      encodeURIComponent('PSOP');

    return (
      `otpauth://totp/${label}` +
      `?secret=${secret}` +
      `&issuer=${issuer}` +
      '&algorithm=SHA1' +
      '&digits=6' +
      '&period=30'
    );
  }

  verifyCode(
    secret: string,
    code: string,
  ): boolean {
    const normalized =
      code.replace(/\s/g, '');

    if (!/^\d{6}$/.test(normalized)) {
      return false;
    }

    const counter = Math.floor(
      Date.now() / 1000 / 30,
    );

    for (const offset of [-1, 0, 1]) {
      const expected =
        this.generateCode(
          secret,
          counter + offset,
        );

      if (
        this.safeCompare(
          expected,
          normalized,
        )
      ) {
        return true;
      }
    }

    return false;
  }

  encryptSecret(secret: string): string {
    const iv = randomBytes(12);

    const cipher = createCipheriv(
      'aes-256-gcm',
      this.encryptionKey(),
      iv,
    );

    const encrypted = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    return [
      iv.toString('hex'),
      tag.toString('hex'),
      encrypted.toString('hex'),
    ].join(':');
  }

  decryptSecret(value: string): string {
    const [
      ivHex,
      tagHex,
      encryptedHex,
    ] = value.split(':');

    if (
      !ivHex ||
      !tagHex ||
      !encryptedHex
    ) {
      throw new InternalServerErrorException(
        'Invalid MFA secret storage',
      );
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey(),
      Buffer.from(ivHex, 'hex'),
    );

    decipher.setAuthTag(
      Buffer.from(tagHex, 'hex'),
    );

    return Buffer.concat([
      decipher.update(
        Buffer.from(
          encryptedHex,
          'hex',
        ),
      ),
      decipher.final(),
    ]).toString('utf8');
  }

  generateRecoveryCodes(
    count = 10,
  ): string[] {
    return Array.from(
      { length: count },
      () => {
        const bytes = randomBytes(8);

        const value = Array.from(bytes)
          .map(
            (byte) =>
              this.recoveryAlphabet[
                byte %
                  this.recoveryAlphabet
                    .length
              ],
          )
          .join('');

        return (
          value.slice(0, 4) +
          '-' +
          value.slice(4)
        );
      },
    );
  }

  hashRecoveryCode(
    code: string,
  ): string {
    return createHmac(
      'sha256',
      this.encryptionKey(),
    )
      .update(
        this.normalizeRecoveryCode(
          code,
        ),
      )
      .digest('hex');
  }

  recoveryCodeMatches(
    code: string,
    hash: string,
  ): boolean {
    return this.safeCompare(
      this.hashRecoveryCode(code),
      hash,
    );
  }

  private generateCode(
    secret: string,
    counter: number,
  ): string {
    const buffer = Buffer.alloc(8);

    buffer.writeBigUInt64BE(
      BigInt(counter),
    );

    const digest = createHmac(
      'sha1',
      this.base32Decode(secret),
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

  private base32Encode(
    input: Buffer,
  ): string {
    let bits = '';
    let output = '';

    for (const byte of input) {
      bits += byte
        .toString(2)
        .padStart(8, '0');
    }

    for (
      let index = 0;
      index < bits.length;
      index += 5
    ) {
      const chunk = bits
        .slice(index, index + 5)
        .padEnd(5, '0');

      output +=
        this.alphabet[
          Number.parseInt(
            chunk,
            2,
          )
        ];
    }

    return output;
  }

  private base32Decode(
    value: string,
  ): Buffer {
    const normalized = value
      .toUpperCase()
      .replace(/=+$/g, '')
      .replace(/\s/g, '');

    let bits = '';

    for (
      const character of normalized
    ) {
      const index =
        this.alphabet.indexOf(
          character,
        );

      if (index < 0) {
        throw new Error(
          'Invalid Base32 secret',
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

  private encryptionKey(): Buffer {
    const value =
      this.configService
        .getOrThrow<string>(
          'MFA_ENCRYPTION_KEY',
        );

    const key =
      Buffer.from(value, 'hex');

    if (key.length !== 32) {
      throw new InternalServerErrorException(
        'MFA_ENCRYPTION_KEY must contain 32 bytes',
      );
    }

    return key;
  }

  private normalizeRecoveryCode(
    code: string,
  ): string {
    return code
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  private safeCompare(
    first: string,
    second: string,
  ): boolean {
    const firstBuffer =
      Buffer.from(first);

    const secondBuffer =
      Buffer.from(second);

    return (
      firstBuffer.length ===
        secondBuffer.length &&
      timingSafeEqual(
        firstBuffer,
        secondBuffer,
      )
    );
  }
}
