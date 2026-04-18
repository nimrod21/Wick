import crypto from 'node:crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

function getKey(): Buffer {
  const masterKey = config.masterKey;
  if (!masterKey) {
    throw new Error('crypto-vault: COCKPIT_MASTER_KEY is not set');
  }
  return crypto.createHash('sha256').update(masterKey, 'utf8').digest();
}

export function encrypt(plaintext: string): Sealed {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

export function decrypt(sealed: Sealed): string {
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  const plaintext = Buffer.concat([
    decipher.update(sealed.ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

export function maskKey(plaintext: string): string {
  if (!plaintext) return '';
  if (plaintext.length <= 8) return '*'.repeat(plaintext.length);
  const head = plaintext.slice(0, 3);
  const tail = plaintext.slice(-4);
  return `${head}${'x'.repeat(Math.max(4, plaintext.length - 7))}...${tail}`;
}
