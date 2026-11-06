'use strict';
/* Printer discovery through WMI (Win32_Printer): name, driver, state, colour/duplex capability, paper. */
const { ps } = require('./config');

const SCRIPT = `Get-CimInstance Win32_Printer | Select-Object Name,DriverName,PrinterStatus,WorkOffline,DetectedErrorState,
CapabilityDescriptions,PrinterPaperNames | ConvertTo-Json -Depth 3 -Compress`;

// Win32_Printer.PrinterStatus: 1 Other, 2 Unknown, 3 Idle, 4 Printing, 5 Warmup, 6 Stopped, 7 Offline
// DetectedErrorState: 0 Unknown, 1 Other, 2 No error, 3 Low paper, 4 No paper, 5 Low toner, 6 No toner,
//   7 Door open, 8 Jammed, 9 Offline, 10 Service requested, 11 Output bin full
const BLOCKING_ERRORS = new Set([4, 6, 7, 8, 9, 10, 11]);

function toList(json) {
  if (!json || !json.trim()) return [];
  const v = JSON.parse(json);
  return Array.isArray(v) ? v : [v];
}

/** Maps WMI rows to the heartbeat format the server expects. */
function parsePrinters(json, ignore = []) {
  const skip = new Set(ignore.map((n) => n.toLowerCase()));
  return toList(json)
    .filter((p) => p && p.Name && !skip.has(String(p.Name).toLowerCase()))
    .map((p) => {
      const caps = (p.CapabilityDescriptions || []).map((x) => String(x).toLowerCase());
      const papers = (p.PrinterPaperNames || []).map((x) => String(x).toUpperCase());
      let status = 'Normal';
      if (p.WorkOffline || p.PrinterStatus === 7 || p.DetectedErrorState === 9) status = 'Offline';
      else if (p.PrinterStatus === 6 || BLOCKING_ERRORS.has(p.DetectedErrorState)) status = `Error ${p.DetectedErrorState}`;
      return {
        name: String(p.Name).slice(0, 120),
        driver: p.DriverName ? String(p.DriverName).slice(0, 200) : null,
        status,
        color: caps.some((c) => c.includes('color') || c.includes('colour')),
        duplex: caps.some((c) => c.includes('duplex')),
        paperSizes: ['A4', 'A3'].filter((s) => papers.some((n) => n.startsWith(s))).concat(papers.length ? [] : ['A4'])
      };
    });
}

async function discover(config) {
  return parsePrinters(await ps(config, SCRIPT), config.ignorePrinters);
}

module.exports = { discover, parsePrinters };
