# Quick Print agent installer. Run in PowerShell **as Administrator** from the folder that contains:
#   agent\ (this program), SumatraPDF.exe, WinSW-x64.exe, and windows\QuickPrintAgent.xml
# Usage:  .\windows\install.ps1 -ServerUrl https://print.example.com -PairCode ABCD-EFGH
param(
  [Parameter(Mandatory = $true)][string]$ServerUrl,
  [Parameter(Mandatory = $true)][string]$PairCode,
  [string]$Name = $env:COMPUTERNAME
)
$ErrorActionPreference = 'Stop'
$root = 'C:\QuickPrint'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 LTS first (https://nodejs.org), then run this again.' }
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw "Node.js 22 or newer is required (found $(node -v))." }
foreach ($f in @('SumatraPDF.exe', 'WinSW-x64.exe')) { if (-not (Test-Path (Join-Path $PSScriptRoot "..\$f"))) { throw "$f is missing next to the agent folder. See windows\README.md." } }

New-Item -ItemType Directory -Force -Path $root, "$root\agent" | Out-Null
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot '..\src'), (Join-Path $PSScriptRoot '..\package.json') "$root\agent"
Copy-Item -Force (Join-Path $PSScriptRoot '..\SumatraPDF.exe') $root
Copy-Item -Force (Join-Path $PSScriptRoot '..\WinSW-x64.exe') "$root\QuickPrintAgent.exe"
Copy-Item -Force (Join-Path $PSScriptRoot 'QuickPrintAgent.xml') "$root\QuickPrintAgent.xml"

@{ serverUrl = $ServerUrl; agentName = $Name; sumatra = @("$root\SumatraPDF.exe") } | ConvertTo-Json | Set-Content -Encoding UTF8 "$root\config.json"

# Only Administrators and SYSTEM may read the folder (the device secret lives here, DPAPI-encrypted).
icacls $root /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' | Out-Null

$env:QP_AGENT_CONFIG = "$root\config.json"
node "$root\agent\src\main.js" --pair $PairCode
if ($LASTEXITCODE -ne 0) { throw 'Pairing failed. Create a new code in the dashboard and try again.' }

& "$root\QuickPrintAgent.exe" install
& "$root\QuickPrintAgent.exe" start
Write-Host 'Done. Open the dashboard -> Settings -> Printers, switch on the printers to use and set B&W / colour.'
