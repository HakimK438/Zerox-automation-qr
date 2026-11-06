'use strict';
// Stands in for powershell.exe in tests: answers the two scripts the agent runs.
const fs = require('node:fs');
const script = process.argv[process.argv.length - 1];
const read = (f) => (f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
if (script.includes('Win32_Printer')) process.stdout.write(read(process.env.QP_FAKE_PRINTERS));
else if (script.includes('Get-PrintJob')) process.stdout.write(read(process.env.QP_FAKE_SPOOL));
else { process.stderr.write('unknown script'); process.exit(1); }
