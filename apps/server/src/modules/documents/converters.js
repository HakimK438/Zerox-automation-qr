'use strict';
/* Original file -> print-ready PDF + authoritative page count (plan C2).
   Runs inside a worker thread (convertWorker.js) so heavy parsing never blocks the API. */
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { PDFDocument } = require('pdf-lib');
const { findSoffice } = require('../../config/env');

/** An error whose message is safe and helpful to show the customer. */
class ConversionError extends Error {
  constructor(userMessage, internal) { super(userMessage); this.userMessage = userMessage; this.internal = internal; }
}

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 18;
const MAX_IMAGE_PX = 3508; // A4 long edge at 300 dpi

async function loadPdf(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (err && (err.name === 'EncryptedPDFError' || /encrypt/i.test(err.message))) {
      throw new ConversionError('This PDF is password-protected. Please remove the password and upload it again.', err.message);
    }
    throw new ConversionError('This PDF is damaged or unreadable. Please re-save it and try again.', err && err.message);
  }
}

function checkPages(count, maxPages) {
  if (!Number.isInteger(count) || count < 1) throw new ConversionError('This document has no printable pages.');
  if (count > maxPages) throw new ConversionError(`This document has ${count} pages; the limit is ${maxPages}. Please split it into smaller files.`);
}

async function convertPdf(src, dst, { maxPages }) {
  const bytes = await fsp.readFile(src);
  const doc = await loadPdf(bytes);
  const pageCount = doc.getPageCount();
  checkPages(pageCount, maxPages);
  await fsp.copyFile(src, dst);
  return { pageCount };
}

async function convertImage(src, dst, { ext }) {
  const sharp = require('sharp');
  let input = await fsp.readFile(src);
  if (ext === '.heic' || ext === '.heif') {
    try {
      const heicConvert = require('heic-convert');
      input = Buffer.from(await heicConvert({ buffer: input, format: 'JPEG', quality: 0.92 }));
    } catch (err) {
      throw new ConversionError('This photo could not be read. Please upload it as JPG or PNG.', err && err.message);
    }
  }

  let out;
  try {
    out = await sharp(input, { limitInputPixels: 120e6, failOn: 'error' })
      .rotate() // apply EXIF orientation so phone photos don't print sideways
      .resize({ width: MAX_IMAGE_PX, height: MAX_IMAGE_PX, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }) // transparent PNGs print on white
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new ConversionError('This image is damaged or too large to print. Please try another file.', err && err.message);
  }

  const { data, info } = out;
  const landscape = info.width > info.height;
  const pw = landscape ? A4.h : A4.w;
  const ph = landscape ? A4.w : A4.h;
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([pw, ph]);
  const img = await pdf.embedJpg(data);
  const scale = Math.min((pw - 2 * MARGIN) / info.width, (ph - 2 * MARGIN) / info.height);
  const w = info.width * scale;
  const h = info.height * scale;
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  await fsp.writeFile(dst, await pdf.save(), { mode: 0o600 });
  return { pageCount: 1 };
}

const IS_WINDOWS = process.platform === 'win32';

/** Stops soffice and the soffice.bin it started. Linux: the process group. Windows: the process tree. */
function killTree(pid) {
  if (IS_WINDOWS) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => { /* already gone */ });
  else try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** Runs a command with a hard timeout, killing everything it started. */
function run(cmd, args, { timeoutMs, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'ignore', detached: !IS_WINDOWS, windowsHide: true });
    const timer = setTimeout(() => {
      killTree(child.pid);
      reject(new ConversionError('This document took too long to convert. Please save it as PDF and upload again.', 'timeout'));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

/* The converter gets only what it needs to run: no inherited secrets. Windows programs also need a
   few system variables, or LibreOffice cannot start. */
function officeEnv(work) {
  const env = { PATH: process.env.PATH, HOME: work, LANG: 'en_US.UTF-8' };
  if (IS_WINDOWS) {
    for (const k of ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ALLUSERSPROFILE', 'USERNAME']) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    Object.assign(env, { TEMP: work, TMP: work, USERPROFILE: work, APPDATA: work, LOCALAPPDATA: work });
  }
  return env;
}

/** True when the configured LibreOffice can be found (checked at start-up to warn the shop owner). */
function officeConverterAvailable(sofficePath, env = process.env) {
  if (path.isAbsolute(sofficePath)) return fs.existsSync(sofficePath);
  const names = IS_WINDOWS ? [`${sofficePath}.com`, `${sofficePath}.exe`] : [sofficePath];
  return String(env.PATH || '').split(path.delimiter).some((dir) => names.some((n) => dir && fs.existsSync(path.join(dir, n))));
}

async function convertOffice(src, dst, { ext, maxPages, sofficePath, timeoutMs, profileDir }) {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'qp-lo-'));
  // Keeping one profile per slot skips LibreOffice's slow first-run set-up on every job.
  // It holds settings only: each customer file stays in the per-job folder, which is deleted below.
  const profile = profileDir || path.join(work, 'profile');
  try {
    const input = path.join(work, `input${ext}`);
    await fsp.copyFile(src, input);
    const args = [
      '--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck', '--nofirststartwizard',
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--convert-to', 'pdf', '--outdir', work, input
    ];
    try {
      // Looked up for each job, so installing LibreOffice works without restarting the server.
      await run(findSoffice(sofficePath), args, { timeoutMs, cwd: work, env: officeEnv(work) });
    } catch (err) {
      if (err instanceof ConversionError) {
        if (profileDir) await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {}); // may be half written
        throw err;
      }
      if (err && err.code === 'ENOENT') {
        throw new ConversionError('Word and PowerPoint files cannot be converted right now. Please upload a PDF instead.', 'soffice not installed');
      }
      throw new ConversionError('This document could not be converted. Please save it as PDF and upload again.', err && err.message);
    }
    const out = path.join(work, 'input.pdf');
    let bytes;
    try { bytes = await fsp.readFile(out); } catch {
      throw new ConversionError('This document could not be converted. It may be password-protected or damaged. Please save it as PDF and upload again.', 'no output');
    }
    const doc = await loadPdf(bytes);
    const pageCount = doc.getPageCount();
    checkPages(pageCount, maxPages);
    await fsp.writeFile(dst, bytes, { mode: 0o600 });
    return { pageCount };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

async function sha256File(file) {
  return createHash('sha256').update(await fsp.readFile(file)).digest('hex');
}

/**
 * @param {{ kind: 'pdf'|'image'|'office', ext: string, src: string, dst: string, maxPages: number, sofficePath: string, timeoutMs: number }} job
 */
async function convert(job) {
  const fn = job.kind === 'pdf' ? convertPdf : job.kind === 'image' ? convertImage : convertOffice;
  const { pageCount } = await fn(job.src, job.dst, job);
  return { pageCount, pdfSha256: await sha256File(job.dst) };
}

module.exports = { convert, ConversionError, officeConverterAvailable };
