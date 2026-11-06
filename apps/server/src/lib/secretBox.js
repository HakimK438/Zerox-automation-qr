'use strict';
/* Small authenticated encryption helper (AES-256-GCM) for secrets that must be shown again later,
   such as the pickup PIN. Format: "v1:" + base64url(iv[12] | tag[16] | ciphertext). */
const crypto = require('node:crypto');

function createSecretBox(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('secretBox key must be 32 bytes');
  return {
    seal(plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')}`;
    },
    /** @returns {string|null} null if missing, tampered or sealed with another key */
    open(sealed) {
      if (typeof sealed !== 'string' || !sealed.startsWith('v1:')) return null;
      try {
        const raw = Buffer.from(sealed.slice(3), 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    }
  };
}

module.exports = { createSecretBox };
