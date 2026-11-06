'use strict';
/* /api/agent/* — used only by the print agent on the shop PC (customer host; outbound HTTPS from the shop).
     POST /agent/pair            {code, name}            -> {agentId, secret}   (code from the dashboard, single use)
     POST /agent/heartbeat       {printers, version, activeJobs}               every 15 s
     GET  /agent/events          SSE: "work" (lease something now), "revoked"
     POST /agent/jobs/next       -> {job} | {job:null}
     GET  /agent/jobs/:id/pdf    X-Download-Token: single use
     POST /agent/jobs/:id/result {status: spooled|printed|failed|uncertain, spoolerJobId?, error?} */
const fs = require('node:fs');
const express = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { rateLimit } = require('../../middleware/rateLimit');
const { agentAuth } = require('../../middleware/agentAuth');
const { HttpError, notFound } = require('../../lib/errors');
const { UUID_RE } = require('../orders/ownership');

const printerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  driver: z.string().max(200).optional().nullable(),
  status: z.string().max(60).optional().nullable(),
  color: z.boolean().optional(),
  duplex: z.boolean().optional(),
  paperSizes: z.array(z.string().max(10)).max(20).optional()
});
const heartbeatBody = z.object({
  printers: z.array(printerSchema).max(50),
  version: z.string().max(40).optional(),
  activeJobs: z.array(z.string().regex(/^[0-9a-f-]{36}$/)).max(20).optional()
});
const resultBody = z.object({
  status: z.enum(['spooled', 'printed', 'failed', 'uncertain']),
  spoolerJobId: z.union([z.string().max(40), z.number().int()]).optional().nullable(),
  error: z.string().max(300).optional().nullable()
});

function agentRoutes({ agents, dispatcher, logger }) {
  const router = express.Router();
  const pairLimit = rateLimit({ name: 'agent_pair', windowMs: 15 * 60000, max: 10 });
  const perAgent = rateLimit({ name: 'agent', max: 600, keyFn: (req) => req.agent.id });
  const auth = [agentAuth({ agents }), perAgent];
  const streams = new Map(); // agentId -> Set<res>

  router.post('/agent/pair', pairLimit, validate(z.object({ code: z.string().max(20), name: z.string().trim().min(1).max(60) })), (req, res) => {
    const r = agents.pair({ ...req.valid.body, ip: req.ip });
    if (!r) throw new HttpError(400, 'bad_code', 'This pairing code is wrong or expired. Create a new one in the dashboard.');
    res.status(201).json(r);
  });

  router.post('/agent/heartbeat', auth, validate(heartbeatBody), (req, res) => {
    agents.heartbeat(req.agent, req.valid.body);
    if (req.valid.body.activeJobs) dispatcher.extend(req.agent, req.valid.body.activeJobs);
    dispatcher.sweepAutomatic(); // a printer may just have come online
    res.json({ ok: true, paused: dispatcher.paused() });
  });

  router.get('/agent/events', auth, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\nevent: work\ndata: {}\n\n');
    let set = streams.get(req.agent.id);
    if (!set) { set = new Set(); streams.set(req.agent.id, set); }
    if (set.size >= 3) { const old = set.values().next().value; old.end(); set.delete(old); }
    set.add(res);
    req.on('close', () => { set.delete(res); if (!set.size) streams.delete(req.agent.id); });
  });

  router.post('/agent/jobs/next', auth, (req, res) => res.json({ job: dispatcher.nextJob(req.agent) }));

  router.get('/agent/jobs/:jobId/pdf', auth, (req, res, next) => {
    if (!UUID_RE.test(req.params.jobId)) return next(notFound('Job not found.'));
    const file = dispatcher.download(req.agent, req.params.jobId, req.get('x-download-token'));
    if (!file) return next(new HttpError(410, 'gone', 'This download is not available (already used or lease ended).'));
    return fs.stat(file, (err, st) => {
      if (err) return next(notFound('File not found.'));
      res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(st.size), 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).on('error', next).pipe(res);
    });
  });

  router.post('/agent/jobs/:jobId/result', auth, validate(resultBody), (req, res, next) => {
    if (!UUID_RE.test(req.params.jobId)) return next(notFound('Job not found.'));
    const b = req.valid.body;
    const ok = dispatcher.result(req.agent, req.params.jobId, { status: b.status, spoolerJobId: b.spoolerJobId == null ? null : String(b.spoolerJobId), error: b.error });
    if (!ok) return next(new HttpError(409, 'not_leased', 'This job is not leased to this agent.'));
    logger.info('print_result', { jobId: req.params.jobId, status: b.status });
    return res.json({ ok: true });
  });

  const write = (event) => { for (const set of streams.values()) for (const r of set) r.write(`event: ${event}\ndata: {}\n\n`); };
  const unsubscribe = dispatcher.onWork(() => write('work'));
  const heartbeat = setInterval(() => { for (const set of streams.values()) for (const r of set) r.write(': hb\n\n'); }, 25000);
  heartbeat.unref();

  router.disconnect = (agentId) => {
    const set = streams.get(agentId);
    if (set) for (const r of set) { r.write('event: revoked\ndata: {}\n\n'); r.end(); }
    streams.delete(agentId);
  };
  router.close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    for (const set of streams.values()) for (const r of set) r.end();
    streams.clear();
  };
  router.stop = () => { pairLimit.stop(); perAgent.stop(); };
  return router;
}

module.exports = { agentRoutes };
