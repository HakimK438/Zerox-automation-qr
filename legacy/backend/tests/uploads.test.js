const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');

function startServer(port) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_NO_WARNINGS: '1', QP_DB_PATH: path.join(__dirname, `test-uploads-${port}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`) },
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

test('creates a signed upload URL and stores uploaded file metadata against the right order', async () => {
  const port = 4014;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    assert.equal(sessionResponse.status, 201, 'Expected session creation to succeed');
    const sessionCookie = sessionResponse.headers.get('set-cookie');
    const sessionBody = await sessionResponse.json();

    const orderResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        documentName: 'sample.pdf',
        pageCount: 12,
        copies: 2,
        color: 'black-and-white',
        printMode: 'double-sided',
        totalAmount: 35,
        currency: 'INR',
        note: 'Upload test'
      })
    });

    const orderBody = await orderResponse.json();
    assert.equal(orderResponse.status, 201, 'Expected order creation to succeed');

    const uploadUrlResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/files/upload-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({ fileName: 'report.pdf', fileSize: 256000, mimeType: 'application/pdf' })
    });

    assert.equal(uploadUrlResponse.status, 200, 'Expected upload URL request to succeed');
    const uploadUrlBody = await uploadUrlResponse.json();
    assert.ok(uploadUrlBody.uploadUrl, 'Expected uploadUrl to be present');
    assert.ok(uploadUrlBody.storageKey, 'Expected storageKey to be present');
    assert.match(uploadUrlBody.uploadUrl, /report\.pdf|upload/, 'Expected upload URL to contain file reference');

    const fileConfirmResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 256000,
        storageKey: uploadUrlBody.storageKey
      })
    });

    assert.equal(fileConfirmResponse.status, 201, 'Expected file metadata confirmation to succeed');
    const fileBody = await fileConfirmResponse.json();
    assert.ok(fileBody.fileId, 'Expected fileId to be present');
    assert.equal(fileBody.fileName, 'report.pdf', 'Expected file to keep original name');

    const docxUploadResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/files/upload-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        fileName: 'notes.docx',
        fileSize: 180000,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      })
    });

    assert.equal(docxUploadResponse.status, 200, 'Expected DOCX uploads to be accepted');
    const docxUploadBody = await docxUploadResponse.json();
    assert.ok(docxUploadBody.storageKey, 'Expected storage key for DOCX uploads');

    const uniqueJpgKey = `orders/${orderBody.orderId}/accepted-jpg-${Date.now()}`;
    const imageUploadResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        fileName: 'scan.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 120000,
        storageKey: uniqueJpgKey
      })
    });

    assert.equal(imageUploadResponse.status, 201, 'Expected JPG uploads to be accepted');

    const fileListResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/files`, {
      method: 'GET',
      headers: cookieFromHeader(sessionCookie)
    });

    assert.equal(fileListResponse.status, 200, 'Expected file listing to succeed');
    const fileListBody = await fileListResponse.json();
    assert.equal(fileListBody.files.length, 2, 'Expected two uploaded files for the order');
    assert.ok(fileListBody.files.some((file) => file.fileName === 'report.pdf'), 'Expected PDF file to be present in order list');
    assert.ok(fileListBody.files.some((file) => file.fileName === 'scan.jpg'), 'Expected JPG file to be present in order list');
    assert.equal(fileListBody.files[0].sessionId, sessionBody.sessionId, 'Expected file metadata to be tied to the session');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('converts supported uploads to print-ready PDFs and tracks page counts', async () => {
  const port = 4014;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const sessionCookie = sessionResponse.headers.get('set-cookie');
    const sessionBody = await sessionResponse.json();

    const orderResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        documentName: 'document package',
        pageCount: 1,
        copies: 1,
        color: 'black-and-white',
        printMode: 'single-sided',
        totalAmount: 40,
        currency: 'INR'
      })
    });
    const orderBody = await orderResponse.json();

    const samples = [
      {
        fileName: 'sample.pdf',
        mimeType: 'application/pdf',
        content: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 2 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF')
      },
      {
        fileName: 'photo.png',
        mimeType: 'image/png',
        content: Buffer.from([
          0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
          0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
          0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
          0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89,
          0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54,
          0x78, 0x9C, 0x63, 0xF8, 0xFF, 0xFF, 0x3F, 0x00, 0x05, 0x01, 0x01, 0x01, 0x0D, 0x84, 0x23, 0xF7,
          0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
        ])
      },
      {
        fileName: 'notes.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        content: Buffer.from('PK\x03\x04fake-docx')
      }
    ];

    for (const sample of samples) {
      const uploadUrlResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/files/upload-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...cookieFromHeader(sessionCookie)
        },
        body: JSON.stringify({ fileName: sample.fileName, fileSize: sample.content.length, mimeType: sample.mimeType })
      });

      assert.equal(uploadUrlResponse.status, 200, `Expected upload URL for ${sample.fileName} to succeed`);
      const uploadUrlBody = await uploadUrlResponse.json();

      const uploadResponse = await fetch(uploadUrlBody.uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: sample.content
      });

      assert.equal(uploadResponse.status, 200, `Expected file upload to succeed for ${sample.fileName}`);

      const registerResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...cookieFromHeader(sessionCookie)
        },
        body: JSON.stringify({
          fileName: sample.fileName,
          mimeType: sample.mimeType,
          sizeBytes: sample.content.length,
          storageKey: uploadUrlBody.storageKey
        })
      });

      assert.equal(registerResponse.status, 201, `Expected file registration to succeed for ${sample.fileName}`);
      const registered = await registerResponse.json();
      assert.equal(registered.conversionStatus, 'converted', `Expected ${sample.fileName} to be converted`);
      assert.ok(Number.isInteger(registered.pageCount) && registered.pageCount > 0, `Expected ${sample.fileName} to have a positive page count`);
      assert.ok(registered.convertedPdfStorageKey, `Expected ${sample.fileName} to have a converted PDF location`);
    }

    assert.ok(sessionBody.sessionId, 'Expected valid session for conversion test');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('rejects invalid upload metadata and unauthenticated upload requests', async () => {
  const port = 4015;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const sessionCookie = sessionResponse.headers.get('set-cookie');
    const sessionBody = await sessionResponse.json();

    const orderResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        documentName: 'image.pdf',
        pageCount: 8,
        copies: 1,
        color: 'black-and-white',
        printMode: 'single-sided',
        totalAmount: 18,
        currency: 'INR'
      })
    });

    const order = await orderResponse.json();

    const invalidUpload = await fetch(`http://127.0.0.1:${port}/api/orders/${order.orderId}/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        fileName: 'photo.svg',
        mimeType: 'image/svg+xml',
        sizeBytes: 10000,
        storageKey: 'invalid-key'
      })
    });

    assert.equal(invalidUpload.status, 400, 'Expected unsupported file formats to be rejected');

    const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/orders/${order.orderId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 20000,
        storageKey: 'unauthenticated-key'
      })
    });

    assert.equal(unauthenticated.status, 401, 'Expected unauthenticated file registration to be rejected');

    const wrongSession = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const wrongCookie = wrongSession.headers.get('set-cookie');

    const crossSession = await fetch(`http://127.0.0.1:${port}/api/orders/${order.orderId}/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(wrongCookie)
      },
      body: JSON.stringify({
        fileName: 'other.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 30000,
        storageKey: 'cross-key'
      })
    });

    assert.equal(crossSession.status, 403, 'Expected order file uploads to respect session ownership');
    assert.ok(sessionBody.sessionId, 'Expected valid session for the uploader');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});
