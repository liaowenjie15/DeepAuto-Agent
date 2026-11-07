import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type LarkTokenCipher = {
  encrypt(value: string, context: string): string;
  decrypt(value: string, context: string): string;
};

export function createLarkTokenCipher(base64Key: string): LarkTokenCipher {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32 || key.toString('base64') !== base64Key) {
    throw new Error(
      'Lark token encryption key must be 32 base64-encoded bytes',
    );
  }

  return {
    encrypt(value, context) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const ciphertext = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ]);
      return `v1:${nonce.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
    },
    decrypt(value, context) {
      const parts = value.split(':');
      if (parts.length !== 4 || parts[0] !== 'v1') {
        throw new Error('Lark token ciphertext is invalid');
      }
      try {
        const nonce = Buffer.from(parts[1] ?? '', 'base64url');
        const tag = Buffer.from(parts[2] ?? '', 'base64url');
        const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
        if (nonce.length !== 12 || tag.length !== 16 || !ciphertext.length) {
          throw new Error('invalid ciphertext');
        }
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new Error('Lark token ciphertext is invalid');
      }
    },
  };
}
