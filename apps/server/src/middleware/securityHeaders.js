'use strict';
const helmet = require('helmet');

/* Strict headers for every response. Third-party origins (Paytm checkout) are added explicitly
   in the payments phase; vendor JS is self-hosted so script-src stays 'self'. */
function securityHeaders({ isProduction, extraScriptSrc = [], extraConnectSrc = [], extraFrameSrc = [], extraStyleSrc = [], extraImgSrc = [], extraFormAction = [] } = {}) {
  const csp = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", ...extraScriptSrc],
        styleSrc: ["'self'", ...extraStyleSrc],
        // the existing UI sets inline style attributes; allow attributes only, not <style> blocks
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', ...extraImgSrc],
        fontSrc: ["'self'"],
        connectSrc: ["'self'", ...extraConnectSrc],
        workerSrc: ["'self'", 'blob:'],
        frameSrc: extraFrameSrc.length ? extraFrameSrc : ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'", ...extraFormAction],
        frameAncestors: ["'none'"],
        ...(isProduction ? { upgradeInsecureRequests: [] } : {})
      }
    },
    strictTransportSecurity: isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false
  });

  return (req, res, next) => {
    // API responses carry private order data: never cache them anywhere.
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    csp(req, res, next);
  };
}

module.exports = { securityHeaders };
