'use strict';
/* Minimal structured (JSON-lines) logger. Never log file contents, file names, tokens, PINs or cookies. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function createLogger({ level = 'info', stream = process.stdout } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    stream.write(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...fields }) + '\n');
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields)
  };
}

module.exports = { createLogger };
