'use strict';
/* Long-lived worker thread: converts documents one at a time on request.
   Kept alive between jobs because starting a fresh isolate costs ~0.5 s of CPU per job. */
const { parentPort } = require('node:worker_threads');
const { convert, ConversionError } = require('./converters');

parentPort.on('message', async ({ jobId, job }) => {
  try {
    const result = await convert(job);
    parentPort.postMessage({ jobId, ok: true, ...result });
  } catch (err) {
    parentPort.postMessage({
      jobId,
      ok: false,
      userMessage: err instanceof ConversionError ? err.userMessage : 'This file could not be prepared for printing. Please try another file.',
      internal: err instanceof ConversionError ? err.internal : (err && err.stack) || String(err)
    });
  }
});
