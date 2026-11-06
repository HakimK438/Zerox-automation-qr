'use strict';
const { unauthorized } = require('../lib/errors');

/** Print agent authentication: `Authorization: Bearer <device secret>`. No cookies, never a browser. */
function agentAuth({ agents }) {
  return (req, res, next) => {
    const m = /^Bearer\s+(\S+)$/.exec(req.get('authorization') || '');
    const agent = m ? agents.authenticate(m[1]) : null;
    if (!agent) return next(unauthorized('Print agent not paired or revoked.'));
    req.agent = agent;
    return next();
  };
}

module.exports = { agentAuth };
