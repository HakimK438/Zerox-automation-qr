const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');

function startServer(port) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_NO_WARNINGS: '1',
      QP_ADMIN_USERNAME: 'admin',
      QP_ADMIN_PASSWORD: 'admin123',
      QP_DB_PATH: path.join(__dirname, `test-admin-${port}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return child;
}

function waitForServer(child, port) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = async () => {
      if (Date.now() - startedAt > 10000) {
        child.kill('SIGTERM');
        reject(new Error(`Server on port ${port} did not start in time.`));
        return;
      }

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch (error) {
        // keep polling while the server starts up
      }

      setTimeout(check, 100);
    };

    check();
  });
}

function cookieFromHeader(header) {
  if (!header) return {};
  const match = header.match(/quick_print_session=([^;]+)/);
  if (!match) return {};
  return { Cookie: `quick_print_session=${match[1]}` };
}

function adminCookieFromHeader(header) {
  if (!header) return {};
  const match = header.match(/quick_print_admin_session=([^;]+)/);
  if (!match) return {};
  return { Cookie: `quick_print_admin_session=${match[1]}` };
}

test('admin login succeeds with correct credentials and protected dashboard routes require authentication', async () => {
  const port = 4045;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const invalidLogin = await fetch(`http://127.0.0.1:${port}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' })
    });

    assert.equal(invalidLogin.status, 401, 'Expected invalid admin credentials to be rejected');

    const loginResponse = await fetch(`http://127.0.0.1:${port}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });

    assert.equal(loginResponse.status, 200, 'Expected valid admin login to succeed');
    const setCookieHeader = loginResponse.headers.get('set-cookie');
    assert.ok(setCookieHeader, 'Expected admin session cookie to be set');

    const unauthenticatedDashboard = await fetch(`http://127.0.0.1:${port}/api/admin/dashboard`);
    assert.equal(unauthenticatedDashboard.status, 401, 'Expected protected admin dashboard to require a session');

    const dashboardResponse = await fetch(`http://127.0.0.1:${port}/api/admin/dashboard`, {
      headers: adminCookieFromHeader(setCookieHeader)
    });

    assert.equal(dashboardResponse.status, 200, 'Expected authenticated admin dashboard to load');
    const dashboardBody = await dashboardResponse.json();
    assert.equal(dashboardBody.admin.username, 'admin', 'Expected admin metadata to be returned');
    assert.ok(Array.isArray(dashboardBody.orders), 'Expected order list in dashboard response');
    assert.ok(Array.isArray(dashboardBody.queue), 'Expected queue list in dashboard response');

    const ordersResponse = await fetch(`http://127.0.0.1:${port}/api/admin/orders`, {
      headers: adminCookieFromHeader(setCookieHeader)
    });
    assert.equal(ordersResponse.status, 200, 'Expected admin orders list to be accessible');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('customer sessions cannot access admin endpoints and admin can manage order status', async () => {
  const port = 4046;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const customerSessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const customerCookie = customerSessionResponse.headers.get('set-cookie');
    const customerSession = await customerSessionResponse.json();

    const orderResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(customerCookie)
      },
      body: JSON.stringify({
        documentName: 'admin-guard.pdf',
        pageCount: 8,
        copies: 2,
        color: 'black-and-white',
        printMode: 'double-sided',
        totalAmount: 18,
        currency: 'INR'
      })
    });
    const orderBody = await orderResponse.json();

    const customerAccess = await fetch(`http://127.0.0.1:${port}/api/admin/orders/${orderBody.orderId}`, {
      headers: cookieFromHeader(customerCookie)
    });
    assert.equal(customerAccess.status, 403, 'Expected customer session to be rejected by admin endpoint');

    const loginResponse = await fetch(`http://127.0.0.1:${port}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const adminCookie = loginResponse.headers.get('set-cookie');

    const adminOrderResponse = await fetch(`http://127.0.0.1:${port}/api/admin/orders/${orderBody.orderId}`, {
      headers: adminCookieFromHeader(adminCookie)
    });
    assert.equal(adminOrderResponse.status, 200, 'Expected admin to view an order by id');

    const statusPatch = await fetch(`http://127.0.0.1:${port}/api/admin/orders/${orderBody.orderId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...adminCookieFromHeader(adminCookie)
      },
      body: JSON.stringify({ status: 'paid' })
    });
    assert.equal(statusPatch.status, 200, 'Expected admin to advance the order status');
    const statusBody = await statusPatch.json();
    assert.equal(statusBody.order.status, 'paid', 'Expected admin status update to persist');
    assert.equal(statusBody.actor, 'admin', 'Expected status update to record the admin actor');
    assert.ok(statusBody.auditId, 'Expected audit trail id for the status change');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});
