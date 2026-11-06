'use strict';
/* Agent configuration: config.json next to the program (server URL, executables), and the device
   secret in a separate file. On Windows the secret is encrypted with DPAPI (LocalMachine scope, so the
   Windows service can read what the admin's pairing command wrote; useless if the file is copied to
   another PC). Elsewhere (tests, development) it is a 0600 file. */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const IS_WINDOWS = process.platform === 'win32';
const POWERSHELL = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

function defaults(dir) {
  return {
    serverUrl: '',                 // https://print.example.com (the customer site; never the admin site)
    agentName: require('node:os').hostname(),
    powershell: POWERSHELL,        // command prefix; tests use [node, fake-powershell.js]
    sumatra: [path.join(dir, 'SumatraPDF.exe')],
    workDir: path.join(dir, 'work'),
    logFile: path.join(dir, 'agent.log'),
    secretFile: path.join(dir, 'secret.dat'),
    heartbeatSec: 15,
    pollSec: 10,
    printTimeoutSec: 300,
    spoolerTimeoutSec: 1800,
    // Virtual printers are never offered to the shop.
    ignorePrinters: ['Microsoft Print to PDF', 'Microsoft XPS Document Writer', 'OneNote', 'Fax', 'Send To OneNote', 'AnyDesk Printer']
  };
}

function loadConfig(dir = path.resolve(__dirname, '..'), file = process.env.QP_AGENT_CONFIG || path.join(dir, 'config.json')) {
  let user = {};
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = { ...defaults(path.dirname(file)), ...user };
  if (c.serverUrl) {
    const u = new URL(c.serverUrl);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('serverUrl must be https://');
    c.serverUrl = u.origin;
  }
  return c;
}

function ps(config, script, env = {}) {
  const [cmd, ...pre] = config.powershell;
  return new Promise((resolve, reject) => {
    execFile(cmd, [...pre, script], { env: { ...process.env, ...env }, timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(`powershell failed: ${stderr || err.message}`)) : resolve(stdout)));
  });
}

const DPAPI_SAVE = `Add-Type -AssemblyName System.Security;
$b=[Text.Encoding]::UTF8.GetBytes($env:QP_SECRET);
[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'LocalMachine'))`;
const DPAPI_LOAD = `Add-Type -AssemblyName System.Security;
$b=[Convert]::FromBase64String($env:QP_BLOB);
[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'LocalMachine'))`;

async function saveSecret(config, secret) {
  const data = IS_WINDOWS ? `dpapi:${(await ps(config, DPAPI_SAVE, { QP_SECRET: secret })).trim()}` : `plain:${secret}`;
  fs.writeFileSync(config.secretFile, data, { mode: 0o600 });
}

async function loadSecret(config) {
  if (!fs.existsSync(config.secretFile)) return null;
  const raw = fs.readFileSync(config.secretFile, 'utf8').trim();
  if (raw.startsWith('plain:')) return raw.slice(6);
  if (raw.startsWith('dpapi:')) return (await ps(config, DPAPI_LOAD, { QP_BLOB: raw.slice(6) })).trim();
  return null;
}

module.exports = { loadConfig, saveSecret, loadSecret, ps, IS_WINDOWS };
