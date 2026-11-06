'use strict';
/* Creates the first admin (or resets one). There is no default admin account, ever.
     npm run admin:create                -> new owner account
     npm run admin:create -- --staff     -> counter staff (orders only; no money, prices or settings)
     npm run admin:create -- --reset     -> new password + new authenticator code; logs out everywhere
   The password is typed at a hidden prompt (never on the command line, so it is not in shell history).
   Prints the authenticator setup key and an otpauth:// link; add it to Google Authenticator,
   Microsoft Authenticator or Authy, then log in with the 6-digit code. */
const fs = require('node:fs');
const readline = require('node:readline');
const { loadConfig } = require('../src/config/env');
const { openDatabase } = require('../src/db');
const { createSecretBox } = require('../src/lib/secretBox');
const { createAdminAuth, passwordProblem } = require('../src/modules/admin/auth');
const { otpauthUri } = require('../src/lib/totp');
const qrcode = require('../../web/vendor/qrcode/qrcode.js');

/** QR code drawn with half-block characters (scan it with the authenticator app). */
function terminalQr(text) {
  const q = qrcode(0, 'L');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c);
  const out = [];
  for (let r = -2; r < n + 2; r += 2) {
    let line = '';
    for (let c = -2; c < n + 2; c += 1) {
      const top = dark(r, c), bottom = dark(r + 1, c);
      line += top && bottom ? ' ' : top ? '\u2584' : bottom ? '\u2580' : '\u2588';
    }
    out.push(`  ${line}`);
  }
  return out.join('\n');
}

// One reader for every question (separate readers would each swallow the rest of piped input).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
let hiddenPrompt = null;
const write = rl._writeToOutput.bind(rl);
rl._writeToOutput = (s) => {
  if (hiddenPrompt === null || s.includes(hiddenPrompt)) return write(s);
  if (s !== '\r\n' && s !== '\n') return write('*');
  return undefined;
};
const lines = [];
const waiting = [];
rl.on('line', (l) => { if (waiting.length) waiting.shift()(l); else lines.push(l); });
rl.on('close', () => { while (waiting.length) waiting.shift()(''); });

function ask(question, { hidden = false } = {}) {
  hiddenPrompt = hidden ? question : null;
  rl.setPrompt(question);
  rl.prompt();
  return new Promise((resolve) => {
    const done = (answer) => { if (hidden && process.stdin.isTTY) process.stdout.write('\n'); hiddenPrompt = null; resolve(answer); };
    if (lines.length) done(lines.shift()); else waiting.push(done);
  });
}


(async () => {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const role = args.includes('--staff') ? 'staff' : 'owner';
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(config.dbPath);
  const auth = createAdminAuth({ db, secretBox: createSecretBox(config.dataKey), dataKey: config.dataKey });

  const username = (await ask('Admin username: ')).trim();
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) { console.error('Username: 3-64 letters, digits, . _ -'); process.exit(1); }
  const exists = db.prepare('SELECT 1 FROM admin_users WHERE username = ?').get(username);
  if (reset && !exists) { console.error(`No admin named "${username}".`); process.exit(1); }
  if (!reset && exists) { console.error(`"${username}" already exists. Use --reset to change its password and code.`); process.exit(1); }

  const pw = await ask('Password (min 12 characters): ', { hidden: true });
  const problem = passwordProblem(pw, username);
  if (problem) { console.error(problem); process.exit(1); }
  if (await ask('Repeat password: ', { hidden: true }) !== pw) { console.error('Passwords do not match.'); process.exit(1); }

  const r = reset ? auth.resetUser({ username, password: pw }) : auth.createUser({ username, password: pw, role });
  const uri = otpauthUri({ secret: r.totpSecret, account: username, issuer: 'Quick Print' });
  console.log(`\n${reset ? 'Reset' : 'Created'} ${reset ? '' : `${role} `}"${username}".`);
  console.log('\nAdd this to your authenticator app (choose "Enter a setup key", time-based):');
  console.log(`  Account: Quick Print (${username})`);
  console.log(`  Key:     ${r.totpSecret.match(/.{1,4}/g).join(' ')}`);
  if (process.stdout.isTTY) console.log(`\nOr scan this with the authenticator app:\n\n${terminalQr(uri)}\n`);
  console.log(`\nSetup link (same thing as the QR code):\n  ${uri}`);
  console.log(`\nThen log in at ${config.adminOrigin}`);
  db.close();
  rl.close();
})().catch((err) => { console.error(err.message); process.exit(1); });
