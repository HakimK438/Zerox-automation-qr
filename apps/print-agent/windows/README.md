# Quick Print agent — install on the shop's Windows PC

The agent finds the printers on this PC, shows them in the dashboard, and prints paid orders.
It only makes **outbound HTTPS** connections to your shop site: no ports to open, no remote access.

## You need
1. **Windows 10 or 11** with the printers installed and working (print a test page first).
2. **Node.js 22 LTS** — https://nodejs.org (Windows Installer, 64-bit). Keep the default options.
3. **SumatraPDF portable 64-bit** — https://www.sumatrapdfreader.org/download-free-pdf-viewer
   (the "portable version" zip). Rename the exe to `SumatraPDF.exe`.
4. **WinSW** (runs the agent as a Windows service) — https://github.com/winsw/winsw/releases,
   file `WinSW-x64.exe` (v2.12.0 or newer v2.x).

Put the `print-agent` folder, `SumatraPDF.exe` and `WinSW-x64.exe` together, e.g. on the Desktop:
```
print-agent\
  src\  windows\  package.json
  SumatraPDF.exe
  WinSW-x64.exe
```

## Install (5 minutes)
1. Dashboard → **Settings → Printers → Add print agent**. A code like `K7QM-3XPA` appears (valid 10 minutes).
2. Open **PowerShell as Administrator** in the `print-agent` folder and run:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\windows\install.ps1 -ServerUrl https://YOUR-SHOP-SITE -PairCode K7QM-3XPA
   ```
3. In the dashboard the agent shows **Connected** and lists your printers.
   Switch **on** the ones to use, choose **B&W / Colour / Any**, and set the pages-per-minute.
4. Pay a small test order from your phone and watch it print.

## Everyday use
- **Automatic** mode: paid orders print by themselves. **Manual**: click *Start printing*.
- **Stop Everything** stops new prints; a page already sent to the printer finishes.
- If anything goes wrong (paper jam, printer off, PC restarted mid-job) the order moves to
  **Needs attention**. The agent **never reprints by itself**; check the paper and click *Print again*
  only if needed.

## Maintenance
- Logs: `C:\QuickPrint\agent.log` (no customer file names or contents).
- Restart: `C:\QuickPrint\QuickPrintAgent.exe restart`
- Remove: `C:\QuickPrint\QuickPrintAgent.exe stop` then `uninstall`, and **Revoke** the agent in the dashboard.
- New PC / reinstall: revoke the old agent in the dashboard, then install again with a new code.

## Notes
- Printing uses SumatraPDF: `-print-to "<printer>" -print-settings "<pages>,<simplex|duplexlong>,<color|monochrome>,<N>x,paper=<A4|A3>,fit" -silent`.
- "Done" means the Windows print queue finished the job. Most printers report this when the last page
  has been received, which is the best Windows can tell us.
- The device secret is stored in `C:\QuickPrint\secret.dat`, encrypted with Windows DPAPI (machine scope)
  and readable only by Administrators/SYSTEM. Copying it to another PC does not work.
