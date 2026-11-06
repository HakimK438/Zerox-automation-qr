'use strict';
// Stands in for SumatraPDF.exe in tests: records the command line, checks the file exists.
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.length - 1];
fs.appendFileSync(process.env.QP_FAKE_SUMATRA_LOG, `${JSON.stringify({ args, fileExists: fs.existsSync(file), bytes: fs.existsSync(file) ? fs.statSync(file).size : 0 })}\n`);
process.exit(Number(process.env.QP_FAKE_SUMATRA_EXIT || 0));
