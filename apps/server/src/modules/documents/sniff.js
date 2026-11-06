'use strict';
/* Content-based file type check (plan C2). The extension, the declared type and the actual bytes
   must all agree; office ZIPs are inspected (without extraction) to reject macro documents. */
const fsp = require('node:fs/promises');
const path = require('node:path');
const yauzl = require('yauzl');
const { badRequest } = require('../../lib/errors');
const { UPLOAD_TYPES } = require('../../../../../shared/constants');

/* Canonical MIME per extension, and the conversion lane it uses. */
const KINDS = {
  '.pdf': { mime: 'application/pdf', kind: 'pdf', magic: 'pdf' },
  '.jpg': { mime: 'image/jpeg', kind: 'image', magic: 'jpeg' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image', magic: 'jpeg' },
  '.png': { mime: 'image/png', kind: 'image', magic: 'png' },
  '.heic': { mime: 'image/heic', kind: 'image', magic: 'heif' },
  '.heif': { mime: 'image/heic', kind: 'image', magic: 'heif' },
  '.doc': { mime: 'application/msword', kind: 'office', magic: 'cfb' },
  '.ppt': { mime: 'application/vnd.ms-powerpoint', kind: 'office', magic: 'cfb' },
  '.docx': { mime: UPLOAD_TYPES['.docx'][0], kind: 'office', magic: 'zip', mustContain: 'word/document.xml' },
  '.pptx': { mime: UPLOAD_TYPES['.pptx'][0], kind: 'office', magic: 'zip', mustContain: 'ppt/presentation.xml' }
};

/* Canonical MIME -> extension, used to name the file for LibreOffice / pick the decoder. */
const EXT_FOR_MIME = Object.fromEntries(Object.entries(KINDS).map(([ext, k]) => [k.mime, ext]));
EXT_FOR_MIME['image/jpeg'] = '.jpg';

const SWAPPED = { '.doc': '.docx', '.docx': '.doc', '.ppt': '.pptx', '.pptx': '.ppt' };

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const UNSUPPORTED = 'This file type is not supported. Please upload a PDF, Word, PowerPoint, JPG, PNG or HEIC file.';
const MISMATCH = "This file's content doesn't match its type. Please re-save it and try again.";

function magicOf(head) {
  if (head.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return 'pdf';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.subarray(4, 8).toString('latin1') === 'ftyp' && HEIF_BRANDS.has(head.subarray(8, 12).toString('latin1'))) return 'heif';
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'cfb';
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'zip';
  return null;
}

/** Lists ZIP entry names without extracting anything (zip-bomb safe). */
function zipEntryNames(filePath, maxEntries = 20000) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);
      if (zip.entryCount > maxEntries) { zip.close(); return reject(new Error('too many entries')); }
      const names = [];
      zip.on('entry', (e) => { names.push(e.fileName); zip.readEntry(); });
      zip.on('end', () => resolve(names));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/**
 * @param {string} filePath uploaded file on disk
 * @param {string} originalName client file name (only its extension is used)
 * @param {string} declaredMime Content-Type the browser sent for the part
 * @returns {Promise<{ ext: string, mime: string, kind: 'pdf'|'image'|'office' }>}
 */
async function sniffUpload(filePath, originalName, declaredMime) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  const spec = KINDS[ext];
  if (!spec) throw badRequest(UNSUPPORTED);

  // Browsers are inconsistent about declared types (octet-stream, empty, HEIC unknown on desktop);
  // a declared type is only rejected when it positively contradicts the extension.
  const declared = String(declaredMime || '').toLowerCase();
  const neutral = !declared || declared === 'application/octet-stream';
  if (!neutral && !(UPLOAD_TYPES[ext] || []).includes(declared)) throw badRequest(MISMATCH);

  const fh = await fsp.open(filePath, 'r');
  let head;
  try {
    head = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    head = head.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  /* Old .doc and new .docx files often carry each other's extension after being renamed or
     sent around. The bytes say which one it really is; LibreOffice reads both. */
  const magic = magicOf(head);
  let actual = spec;
  if (spec.kind === 'office' && magic !== spec.magic && SWAPPED[ext]) actual = KINDS[SWAPPED[ext]];
  if (magic !== actual.magic) throw badRequest(MISMATCH);

  if (actual.magic === 'zip') {
    let names;
    try { names = await zipEntryNames(filePath); } catch { throw badRequest(MISMATCH); }
    if (!names.includes(actual.mustContain)) throw badRequest(MISMATCH);
    if (names.some((n) => /vbaProject\.bin$/i.test(n) || /vbaData\.xml$/i.test(n))) {
      throw badRequest('Documents with macros are not accepted. Please save it as a normal .docx/.pptx or PDF.');
    }
  }
  return { ext, mime: actual.mime, kind: actual.kind };
}

const kindOfMime = (mime) => (mime === 'application/pdf' ? 'pdf' : mime.startsWith('image/') ? 'image' : 'office');

module.exports = { sniffUpload, kindOfMime, EXT_FOR_MIME, UNSUPPORTED };
