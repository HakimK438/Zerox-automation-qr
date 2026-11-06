'use strict';
const { badRequest } = require('../lib/errors');

/**
 * Validates req[part] against a zod schema and stores the parsed value in req.valid[part].
 * Handlers must read from req.valid, never from raw req.body/query/params.
 */
function validate(schema, part = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[part] ?? {});
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return next(badRequest('Invalid request.', issues));
    }
    req.valid = req.valid || {};
    req.valid[part] = result.data;
    return next();
  };
}

module.exports = { validate };
