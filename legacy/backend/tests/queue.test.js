const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');

function startServer(port) {
  return spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_NO_WARNINGS: '1',
      QP_DB_PATH: path.join(__dirname, `test-queue-${port}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function cookieFromHeader(header) {
  if (!header) return {};
  const match = header.match(/quick_print_session=([^;]+)/);
  if (!match) return {};
  return { Cookie: `quick_print_session=${match[1]}` };
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      // retry until the server is ready
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server on port ${port} did not become healthy in time.`);
}

async function createOrder(port, cookie, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...cookieFromHeader(cookie)
    },
    body: JSON.stringify(payload)
  });

  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body;
}

async function createPaidOrder(port, cookie, payload) {
  const order = await createOrder(port, cookie, payload);
  const paymentCreate = await fetch(`http://127.0.0.1:${port}/api/orders/${order.orderId}/payments/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...cookieFromHeader(cookie)
    },
    body: JSON.stringify({ amount: payload.totalAmount, currency: payload.currency, gateway: 'demo' })
  });

  const paymentBody = await paymentCreate.json();
  assert.equal(paymentCreate.status, 201, JSON.stringify(paymentBody));

  const confirmResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${order.orderId}/payments/confirm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...cookieFromHeader(cookie)
    },
    body: JSON.stringify({
      paymentId: paymentBody.paymentId,
      provider: 'demo',
      status: 'success',
      amount: payload.totalAmount,
      currency: payload.currency,
      reference: `queue-demo-${Date.now()}-${Math.random().toString(16).slice(2)}`
    })
  });

  const confirmBody = await confirmResponse.json();
  assert.equal(confirmResponse.status, 200, JSON.stringify(confirmBody));
  return { ...order, confirmBody };
}

test('calculates queue position and ETA on the backend and handles offline printers', async () => {
  const port = 4025;
  const child = startServer(port);

  try {
    await waitForServer(port);

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(sessionResponse.status, 201, 'Expected session creation to succeed');
    const sessionCookie = sessionResponse.headers.get('set-cookie');

    const firstOrder = await createPaidOrder(port, sessionCookie, {
      documentName: 'first-queue.pdf',
      pageCount: 30,
      copies: 2,
      color: 'black-and-white',
      printMode: 'double-sided',
      totalAmount: 80,
      currency: 'INR'
    });

    const secondOrder = await createPaidOrder(port, sessionCookie, {
      documentName: 'second-queue.pdf',
      pageCount: 12,
      copies: 2,
      color: 'color',
      printMode: 'single-sided',
      totalAmount: 40,
      currency: 'INR'
    });

    const printerResponse = await fetch(`http://127.0.0.1:${port}/api/printers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: 'queue-printer',
        name: 'Queue Printer',
        location: 'Counter 1',
        supportedFormats: ['pdf'],
        status: 'online'
      })
    });
    assert.equal(printerResponse.status, 201, 'Expected queue printer registration to succeed');

    const firstQueue = await fetch(`http://127.0.0.1:${port}/api/orders/${firstOrder.orderId}/queue`, {
      method: 'GET',
      headers: cookieFromHeader(sessionCookie)
    });
    const firstQueueBody = await firstQueue.json();

    const secondQueue = await fetch(`http://127.0.0.1:${port}/api/orders/${secondOrder.orderId}/queue`, {
      method: 'GET',
      headers: cookieFromHeader(sessionCookie)
    });
    const secondQueueBody = await secondQueue.json();

    assert.equal(firstQueue.status, 200, 'Expected first queue snapshot to be available');
    assert.equal(firstQueueBody.queuePosition, 1, 'Expected first paid order to be first in queue');
    assert.equal(secondQueue.status, 200, 'Expected second queue snapshot to be available');
    assert.equal(secondQueueBody.queuePosition, 2, 'Expected second paid order to be second in queue');
    assert.ok(Number.isFinite(firstQueueBody.etaMinutes) && firstQueueBody.etaMinutes >= 2, 'Expected ETA to be server-generated and positive');
    assert.ok(Number.isFinite(secondQueueBody.etaMinutes) && secondQueueBody.etaMinutes >= firstQueueBody.etaMinutes, 'Expected later queue items to have a later ETA');

    const offlinePrinter = await fetch(`http://127.0.0.1:${port}/api/printers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: 'queue-printer',
        name: 'Queue Printer',
        location: 'Counter 1',
        supportedFormats: ['pdf'],
        status: 'offline'
      })
    });
    assert.equal(offlinePrinter.status, 200, 'Expected existing queue printer to be marked offline');

    const thirdOrder = await createPaidOrder(port, sessionCookie, {
      documentName: 'third-queue.pdf',
      pageCount: 18,
      copies: 1,
      color: 'black-and-white',
      printMode: 'single-sided',
      totalAmount: 30,
      currency: 'INR'
    });

    const thirdQueue = await fetch(`http://127.0.0.1:${port}/api/orders/${thirdOrder.orderId}/queue`, {
      method: 'GET',
      headers: cookieFromHeader(sessionCookie)
    });
    const thirdQueueBody = await thirdQueue.json();

    assert.equal(thirdQueue.status, 200, 'Expected queue snapshot to be returned even when there is no online printer');
    assert.equal(thirdQueueBody.printerStatus, 'offline', 'Expected offline printer status to be reported');
    assert.equal(thirdQueueBody.etaMinutes, null, 'Expected ETA to be unavailable when the printer is offline');
    assert.equal(thirdQueueBody.queueStatus, 'awaiting_printer', 'Expected queue status to explain printer unavailability');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});
