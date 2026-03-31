/**
 * AES-256-GCM encryption helpers for credential storage.
 * Uses a 32-byte key from the ENCRYPTION_KEY env var (base64-encoded).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from './config.js';

function getKey() {
  const raw = config.encryptionKey;
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be exactly 32 bytes (base64-encoded).');
  }
  return buf;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * @returns {{ ciphertext: string, iv: string, tag: string }} all hex-encoded
 */
export function encrypt(plaintext) {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt a ciphertext encrypted with encrypt().
 * @param {string} ciphertext hex-encoded
 * @param {string} iv hex-encoded (12 bytes)
 * @param {string} tag hex-encoded (16 bytes)
 * @returns {string} plaintext
 */
export function decrypt(ciphertext, iv, tag) {
  const key = getKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
