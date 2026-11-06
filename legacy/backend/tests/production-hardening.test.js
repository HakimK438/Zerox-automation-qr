const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');

function startServer(port) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      QP_DB_PATH: path.join(__dirname, `test-production-${port}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`),
      QP_RATE_LIMIT_PER_MINUTE: '3',
      QP_MAX_UPLOAD_MB: '0.5',
      NODE_NO_WARNINGS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return child;
}

test('production sessions use secure HTTP-only cookies', async () => {
  const child = startServer(4015);

  try {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    await once(child.stdout, 'data');

    const response = await fetch('http://127.0.0.1:4015/api/sessions/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const cookie = response.headers.get('set-cookie');
    assert.ok(cookie, 'Expected a Set-Cookie header in production mode');
    assert.match(cookie, /HttpOnly/i, 'Expected the cookie to be HttpOnly in production');
    assert.match(cookie, /Secure/i, 'Expected the cookie to be marked Secure in production');

    const body = await response.json();
    assert.equal(body.token, undefined, 'Expected no raw session token in the JSON response');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('enforces request rate limits and upload size caps in production', async () => {
  const child = startServer(4016);

  try {
    await once(child.stdout, 'data');

    let statusCodes = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch('http://127.0.0.1:4016/api/health');
      statusCodes.push(res.status);
    }

    assert.ok(statusCodes.some((status) => status === 429), 'Expected the server to rate-limit repeated requests');

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const uploadResponse = await fetch('http://127.0.0.1:4016/api/uploads/example', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Forwarded-For': '198.51.100.9'
      },
      body: Buffer.alloc(2 * 1024 * 1024)
    });

    assert.equal(uploadResponse.status, 413, 'Expected oversized uploads to be rejected');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('exposes a production readiness check for database and storage health', async () => {
  const child = startServer(4017);

  try {
    await once(child.stdout, 'data');

    const response = await fetch('http://127.0.0.1:4017/api/ready');
    assert.equal(response.status, 200, 'Expected the backend readiness endpoint to return 200 when dependencies are healthy');

    const body = await response.json();
    assert.equal(body.ok, true, 'Expected readiness to report the backend is okay');
    assert.equal(body.database, 'ok', 'Expected readiness to report the database status');
    assert.equal(body.storage, 'ok', 'Expected readiness to report the upload storage status');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});
