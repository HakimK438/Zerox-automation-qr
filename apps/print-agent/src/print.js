'use strict';
/* Printing with SumatraPDF (portable, silent, no UI) and following the job in the Windows spooler.
   https://www.sumatrapdfreader.org/docs/Command-line-arguments */
const { execFile } = require('node:child_process');
const path = require('node:path');
const { ps } = require('./config');

/** SumatraPDF -print-settings for one part: page ranges, sides, colour, copies, paper, fit to page. */
function printSettings(s) {
  const parts = [];
  if (s.pages && s.pages !== 'all') parts.push(String(s.pages).replace(/\s+/g, ''));
  parts.push(s.duplex ? 'duplexlong' : 'simplex');
  parts.push(s.color ? 'color' : 'monochrome');
  parts.push(`${Math.max(1, Math.min(500, s.copies | 0))}x`);
  parts.push(`paper=${s.paper === 'A3' ? 'A3' : 'A4'}`);
  parts.push('fit');
  return parts.join(',');
}

function sumatraArgs(printer, settings, file) {
  return ['-print-to', printer, '-print-settings', printSettings(settings), '-silent', '-exit-on-print', file];
}

function runSumatra(config, printer, settings, file) {
  const [cmd, ...pre] = config.sumatra;
  return new Promise((resolve, reject) => {
    execFile(cmd, [...pre, ...sumatraArgs(printer, settings, file)], { timeout: config.printTimeoutSec * 1000, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error(`SumatraPDF failed (${err.code ?? err.signal}): ${String(stderr).slice(0, 200)}`)) : resolve()));
  });
}

/* Spooler: the job name contains our file name (qp-<jobId>.pdf). */
const SPOOL_SCRIPT = `Get-PrintJob -PrinterName $env:QP_PRINTER | Where-Object { $_.DocumentName -like "*$env:QP_DOC*" } |
Select-Object Id,JobStatus | ConvertTo-Json -Compress`;
const SPOOL_ERROR = /error|paperout|offline|blocked|usererror|intervention/i;

/**
 * Waits until the Windows spooler has finished our job.
 * Resolves 'printed' when it leaves the queue, rejects on an error state or timeout.
 */
async function waitForSpooler(config, printer, file, { intervalMs = 3000, onSpoolId = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const doc = path.basename(file);
  const end = Date.now() + config.spoolerTimeoutSec * 1000;
  let seen = false;
  while (Date.now() < end) {
    let rows = [];
    try {
      const out = (await ps(config, SPOOL_SCRIPT, { QP_PRINTER: printer, QP_DOC: doc })).trim();
      rows = out ? [].concat(JSON.parse(out)) : [];
    } catch {
      await sleep(intervalMs); // PowerShell hiccup: try again
      continue;
    }
    if (!rows.length) return seen ? 'printed' : 'printed_fast'; // left the queue (or was never visible: fast printer)
    seen = true;
    onSpoolId(rows[0].Id);
    const status = String(rows[0].JobStatus || '');
    if (SPOOL_ERROR.test(status)) throw new Error(`printer reported: ${status}`);
    await sleep(intervalMs);
  }
  throw new Error('spooler timeout');
}

module.exports = { printSettings, sumatraArgs, runSumatra, waitForSpooler };
