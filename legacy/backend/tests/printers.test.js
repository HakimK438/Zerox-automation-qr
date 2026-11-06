const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');

function startServer(port) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_NO_WARNINGS: '1', QP_DB_PATH: path.join(__dirname, `test-printers-${port}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`) },
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

function cookieFromHeader(header) {
  if (!header) return {};
  const match = header.match(/quick_print_session=([^;]+)/);
  if (!match) return {};
  return { Cookie: `quick_print_session=${match[1]}` };
}

test('registers a printer, marks it online, and assigns a paid order to it', async () => {
  const port = 4018;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const sessionCookie = sessionResponse.headers.get('set-cookie');

    const orderResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        documentName: 'printer-job.pdf',
        pageCount: 10,
        copies: 1,
        color: 'color',
        printMode: 'single-sided',
        totalAmount: 22,
        currency: 'INR'
      })
    });
    const orderBody = await orderResponse.json();

    const paymentCreateResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({ amount: 22, currency: 'INR', gateway: 'demo' })
    });
    const paymentBody = await paymentCreateResponse.json();

    const paymentConfirmResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({ paymentId: paymentBody.paymentId, status: 'success', reference: 'printer-demo' })
    });
    assert.equal(paymentConfirmResponse.status, 200, 'Expected payment confirmation to succeed');

    const printerResponse = await fetch(`http://127.0.0.1:${port}/api/printers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: 'printer-01',
        name: 'Xerox Front Printer',
        location: 'Counter 1',
        supportedFormats: ['pdf', 'jpg', 'png', 'docx'],
        status: 'online'
      })
    });

    assert.equal(printerResponse.status, 201, 'Expected printer registration to succeed');
    const printerBody = await printerResponse.json();
    assert.equal(printerBody.status, 'online', 'Expected printer to be online after registration');

    const assignResponse = await fetch(`http://127.0.0.1:${port}/api/printers/${printerBody.printerId}/jobs/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: orderBody.orderId })
    });

    assert.equal(assignResponse.status, 201, 'Expected job assignment to succeed');
    const assignmentBody = await assignResponse.json();
    assert.equal(assignmentBody.status, 'queued', 'Expected printer job status to be queued');
    assert.equal(assignmentBody.orderId, orderBody.orderId, 'Expected assigned order to match the paid order');

    const printerJobsResponse = await fetch(`http://127.0.0.1:${port}/api/printers/${printerBody.printerId}/jobs`, {
      method: 'GET'
    });

    assert.equal(printerJobsResponse.status, 200, 'Expected printer job listing to succeed');
    const printerJobs = await printerJobsResponse.json();
    assert.equal(printerJobs.jobs.length, 1, 'Expected one job assigned to the printer');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('rejects invalid printer registration and assignment to unpaid orders', async () => {
  const port = 4019;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const invalidRegister = await fetch(`http://127.0.0.1:${port}/api/printers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad Printer',
        location: 'Counter 2',
        supportedFormats: ['pdf'],
        status: 'online'
      })
    });

    assert.equal(invalidRegister.status, 400, 'Expected printer registration to require printerId');

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const sessionCookie = sessionResponse.headers.get('set-cookie');

    const orderResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        documentName: 'not-paid.pdf',
        pageCount: 3,
        copies: 1,
        color: 'black-and-white',
        printMode: 'single-sided',
        totalAmount: 9,
        currency: 'INR'
      })
    });
    const orderBody = await orderResponse.json();

    const registerResponse = await fetch(`http://127.0.0.1:${port}/api/printers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: 'printer-02',
        name: 'Xerox Second Printer',
        location: 'Counter 2',
        supportedFormats: ['pdf'],
        status: 'online'
      })
    });
    const printerBody = await registerResponse.json();

    const unpaidAssign = await fetch(`http://127.0.0.1:${port}/api/printers/${printerBody.printerId}/jobs/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: orderBody.orderId })
    });

    assert.equal(unpaidAssign.status, 409, 'Expected unpaid orders to be rejected by the printer queue');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});
