'use strict';
/* Public shop information and the upload-page ETA estimate, plus the customer's live-update stream. */
const express = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { rateLimit } = require('../../middleware/rateLimit');

const estimateQuery = z.object({
  bw: z.coerce.number().int().min(0).max(200000).default(0),
  color: z.coerce.number().int().min(0).max(200000).default(0),
  duplex: z.enum(['0', '1']).default('0')
}).strict();

function shopRoutes({ settings, printQueue, hub, session }) {
  const router = express.Router();
  const limiters = [];
  const limit = (opts) => { const l = rateLimit(opts); limiters.push(l); return l; };

  // Name, address, hours and phone for the customer page and the token ticket.
  router.get('/shop', (req, res) => {
    const s = settings.shop();
    res.json({ name: s.name, address: s.address, phone: s.phone, open: s.open, close: s.close });
  });

  // "Ready in about N minutes" before ordering, for bw/color printed sides.
  router.get('/queue/estimate', limit({ name: 'estimate', max: 60 }), validate(estimateQuery, 'query'), (req, res) => {
    const { bw, color, duplex } = req.valid.query;
    res.json(printQueue.estimate({ bwSides: bw, colorSides: color, duplex: duplex === '1' }));
  });

  // Server-Sent Events: this browser's own orders only.
  router.get('/me/events', session.required, limit({ name: 'sse', max: 30 }), hub.handler);

  router.stop = () => limiters.forEach((l) => l.stop());
  return router;
}

module.exports = { shopRoutes };
