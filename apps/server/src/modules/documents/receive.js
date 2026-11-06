'use strict';
/* Streams one multipart file part straight to disk (no buffering in memory), hashing as it goes.
   100 concurrent 5 MB uploads therefore cost disk I/O, not RAM (plan C9). */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const busboy = require('busboy');
const { badRequest, HttpError } = require('../../lib/errors');

const tooLarge = (maxBytes) =>
  new HttpError(413, 'too_large', `File is larger than ${Math.round(maxBytes / 1048576)} MB.`);

/**
 * @returns {Promise<{ tmpPath: string, size: number, sha256: string, filename: string, mimeType: string }>}
 */
function receiveSingleFile(req, { maxBytes, newTmpPath }) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes + 64 * 1024) {
    return Promise.reject(tooLarge(maxBytes));
  }

  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes, fields: 0, parts: 1 } });
    } catch {
      return reject(badRequest('Expected a multipart/form-data file upload.'));
    }

    let filePromise = null;
    bb.on('file', (field, stream, info) => {
      if (field !== 'file' || filePromise) { stream.resume(); return; }
      const tmpPath = newTmpPath();
      const hash = createHash('sha256');
      let size = 0;
      let truncated = false;
      stream.on('data', (chunk) => { hash.update(chunk); size += chunk.length; });
      stream.on('limit', () => { truncated = true; });
      filePromise = pipeline(stream, fs.createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 }))
        .then(() => ({ tmpPath, size, truncated, sha256: hash.digest('hex'), filename: info.filename, mimeType: info.mimeType }))
        .catch(async (err) => { await fsp.rm(tmpPath, { force: true }); throw err; });
    });

    let failed = false;
    bb.on('error', async () => {
      failed = true;
      if (filePromise) await filePromise.then((f) => fsp.rm(f.tmpPath, { force: true }), () => {});
      reject(badRequest('The upload was interrupted. Please try again.'));
    });

    bb.on('close', async () => {
      if (failed) return;
      if (!filePromise) return reject(badRequest('No file was uploaded.'));
      let f;
      try { f = await filePromise; } catch { return reject(badRequest('The upload was interrupted. Please try again.')); }
      if (f.truncated) { await fsp.rm(f.tmpPath, { force: true }); return reject(tooLarge(maxBytes)); }
      if (f.size === 0) { await fsp.rm(f.tmpPath, { force: true }); return reject(badRequest('The file is empty.')); }
      return resolve(f);
    });

    req.pipe(bb);
  });
}

/** Display-only file name: no path parts, control or bidi-override characters, bounded length. */
function cleanFileName(name) {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
  const cleaned = base.normalize('NFC').replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (!cleaned) return 'document';
  if (cleaned.length <= 150) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 6 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 150 - ext.length) + ext;
}

module.exports = { receiveSingleFile, cleanFileName };
