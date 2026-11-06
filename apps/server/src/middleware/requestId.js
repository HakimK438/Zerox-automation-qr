'use strict';
const { randomUUID } = require('node:crypto');

/** Tags every request with an id (echoed as X-Request-Id) and logs one line per finished request. */
function requestId(logger) {
  return (req, res, next) => {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info('request', {
        rid: req.id,
        method: req.method,
        // path only: query strings may carry identifiers we don't want in logs
        path: req.path,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1000000n)
      });
    });
    next();
  };
}

module.exports = { requestId };
