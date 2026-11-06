'use strict';
const { HttpError } = require('../lib/errors');

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
}

/** Final error handler: known errors keep their safe message; everything else becomes a generic 500. */
function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let status = 500;
    let body = { code: 'internal', message: 'Something went wrong. Please try again.' };

    if (err instanceof HttpError) {
      status = err.status;
      body = { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
    } else if (err && err.type === 'entity.too.large') {
      status = 413;
      body = { code: 'too_large', message: 'Request is too large.' };
    } else if (err && (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported')) {
      status = 400;
      body = { code: 'bad_request', message: 'Malformed request body.' };
    }

    if (status >= 500) logger.error('unhandled_error', { rid: req.id, err: err && err.stack ? err.stack : String(err) });
    if (res.headersSent) return res.end();
    return res.status(status).json({ error: body, requestId: req.id });
  };
}

module.exports = { errorHandler, notFoundHandler };
