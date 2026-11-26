# Spike #559 Q1 on Windows: planted node.exe / node.cmd / powershell.exe / sh.exe / sh.cmd in the project folder.
$ErrorActionPreference = 'Continue'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeDir = Join-Path $env:USERPROFILE '.local\bin'
$W = Join-Path $env:RUNNER_TEMP 'w559'
$H = Join-Path $W 'planted'
$env:PATH = "$ClaudeDir;$env:PATH"
$RealNode = (Get-Command node).Source
"=== $([Environment]::OSVersion.VersionString) PS $($PSVersionTable.PSVersion) claude $(& claude --version) node $(& node -v) real node: $RealNode date $((Get-Date).ToUniversalTime().ToString('s'))Z"
$env:USERPROFILE = $H; $env:HOME = $H; $env:APPDATA = "$H\AppData\Roaming"; $env:LOCALAPPDATA = "$H\AppData\Local"
$env:CLAUDE_CONFIG_DIR = "$H\.claude"; $env:DISABLE_AUTOUPDATER = '1'
"installed plugin:"; & claude plugin list --json | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const p of l)if(p.id.startsWith("agent-notebook"))console.log(p.id,p.version,p.installPath)'
$Plug = Get-ChildItem "$H\.claude\plugins\cache\nbloop\agent-notebook" | Select-Object -First 1
$Root = $Plug.FullName
# Compile a tiny exe whose output names itself.
$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
New-Item -ItemType Directory -Force "$W\bin" | Out-Null
& $Csc /nologo /out:"$W\bin\planted.exe" "$Here\planted.cs" | Out-Null
"planted.exe built: $(Test-Path "$W\bin\planted.exe")"
function Plant($dir, $names) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  foreach ($n in $names) {
    if ($n -like '*.exe') { Copy-Item "$W\bin\planted.exe" (Join-Path $dir $n) }
    elseif ($n -like '*.cmd') { Set-Content -Encoding ASCII (Join-Path $dir $n) ('@echo PLANTED-' + $n.ToUpper()) }
  }
}
function Run($label, $names) {
  "################ $label : planted = $($names -join ', ')"
  $d = Join-Path $H ("p-" + ($label -replace '[^a-z0-9]', '')); Plant $d $names; Set-Location $d
  $f = Join-Path $H 'out.jsonl'
  $null | & claude -p hi --output-format stream-json --verbose 2>$null | Out-File -Encoding utf8 $f
  & node "$Here\hookrep.mjs" $f | Where-Object { $_ -notmatch 'SPIKE559-' }
}
Run 'control nothing planted' @()
Run 'node.exe' @('node.exe')
Run 'node.cmd' @('node.cmd')
Run 'powershell.exe' @('powershell.exe')
Run 'sh.exe' @('sh.exe')
Run 'sh.cmd' @('sh.cmd')

"################ nb.cmd from a project folder with planted node (cmd /c), real node on PATH"
$Bin = Join-Path $Root 'bin'
"original nb.cmd:"; Get-Content "$Bin\nb.cmd"
$orig = Get-Content "$Bin\nb.cmd" -Raw
Set-Content -Encoding ASCII "$Bin\nb-m1.cmd" ("@echo off`r`nset NoDefaultCurrentDirectoryInExePath=1`r`nnode `"%~dp0..\dist\cli.js`" %*`r`n")
Set-Content -Encoding ASCII "$Bin\nb-m2.cmd" ("@echo off`r`nsetlocal`r`nset NoDefaultCurrentDirectoryInExePath=1`r`nnode `"%~dp0..\dist\cli.js`" %*`r`nexit /b %errorlevel%`r`n")
foreach ($sc in @(@('none'), @('node.exe'), @('node.cmd'), @('node.exe','node.cmd'))) {
  $d = Join-Path $H ("nb-" + ($sc -join '-')); Plant $d $sc; Set-Location $d
  foreach ($v in 'nb.cmd', 'nb-m1.cmd', 'nb-m2.cmd') {
    $o = & cmd.exe /c "`"$Bin\$v`" --version" 2>&1
    "planted=[$($sc -join ',')] $v -> $(($o | Out-String).Trim() -replace '\r?\n', ' / ')"
  }
}
"--- same, but invoked from PowerShell (no cmd /c): "
Set-Location (Join-Path $H 'nb-node.exe-node.cmd'); $o = & "$Bin\nb.cmd" --version 2>&1; "PS call of nb.cmd with planted node.exe+node.cmd -> $(($o | Out-String).Trim() -replace '\r?\n', ' / ')"
exit 0
