const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');
const defaultDbPath = path.join(__dirname, '..', 'quickprint.db');

function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_NO_WARNINGS: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return child;
}

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Server on port ${port} did not start in time.`));
    }, 10000);

    const onData = (chunk) => {
      const text = chunk.toString();
      if (text.includes(`http://localhost:${port}`)) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        resolve();
      }
    };

    const onError = (chunk) => {
      const text = chunk.toString();
      if (text.includes('ExperimentalWarning')) return;
      clearTimeout(timeout);
      child.stderr.off('data', onError);
      reject(new Error(text));
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onError);
  });
}

test('uses a stable default SQLite database path when no override is supplied', async () => {
  try {
    fs.rmSync(defaultDbPath, { force: true });
  } catch {}

  const port = 4023;
  const child = startServer(port);

  try {
    await waitForServer(child, port);
    assert.ok(fs.existsSync(defaultDbPath), 'Expected quickprint.db to be created in the backend directory by default');
    const stats = fs.statSync(defaultDbPath);
    assert.ok(stats.size >= 0, 'Expected the database file to be created and readable');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});
