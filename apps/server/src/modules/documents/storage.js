'use strict';
/* Private file storage on the data volume (never web-served).
   Layout: <filesDir>/tmp (in-flight uploads), /orig (originals), /pdf (print-ready PDFs).
   File names are server-generated UUIDs; client file names never touch the filesystem. */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { newId } = require('../../lib/crypto');

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createStorage(filesDir) {
  const dirs = {
    tmp: path.join(filesDir, 'tmp'),
    orig: path.join(filesDir, 'orig'),
    pdf: path.join(filesDir, 'pdf')
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

  const assertKey = (key) => {
    if (!KEY_RE.test(String(key))) throw new Error('Invalid storage key.');
    return key;
  };

  return {
    dirs,
    newTmpPath: () => path.join(dirs.tmp, newId()),
    origPath: (key) => path.join(dirs.orig, assertKey(key)),
    pdfPath: (key) => path.join(dirs.pdf, `${assertKey(key)}.pdf`),

    /** Moves a finished upload from tmp into permanent storage; returns its new key. */
    async adopt(tmpPath) {
      const key = newId();
      await fsp.rename(tmpPath, path.join(dirs.orig, key));
      return key;
    },

    async remove(key) {
      await Promise.all([
        fsp.rm(path.join(dirs.orig, assertKey(key)), { force: true }),
        fsp.rm(path.join(dirs.pdf, `${key}.pdf`), { force: true })
      ]);
    },

    /** Deletes partial uploads left behind by a crash or restart. */
    async cleanTmp() {
      for (const f of await fsp.readdir(dirs.tmp)) await fsp.rm(path.join(dirs.tmp, f), { force: true, recursive: true });
    }
  };
}

module.exports = { createStorage };
