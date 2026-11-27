# The plugin end-to-end test for Windows (issue #559), for Windows PowerShell 5.1. It is the twin of
# run.sh, which says what the steps are and why; this file does the same steps and leaves the
# checking to hookrep.mjs and check.mjs.
#
#   powershell -File scripts\plugin-e2e\run.ps1 -BuildDir <build-dir>
#
# Real-asset mode (the marketplace-check workflow): with the environment variable E2E_REAL set, the
# build folder is what `node scripts/check-marketplace.mjs --stage` left; see run.sh. E2E_MKT names the
# marketplace (default agent-notebook); when the first and the second version are the same, the update and
# rollback steps are skipped.
#
# Needs: claude on PATH, node (the new one) on PATH, and the environment variable NODE_OLD_DIR, the
# folder of a Node.js 16. The home folder is named "Ana Maria" with an accent. Git for Windows, MSYS2 and
# PowerShell 7 are renamed out of the way while it runs (and renamed back at the end), so that Claude Code
# finds none of them, as on the computer of a user who has installed nothing. This file is ASCII only on
# purpose: Windows PowerShell 5.1 reads a file without a byte order mark as ANSI.
param([Parameter(Mandatory = $true)][string]$BuildDir)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Ver1 = '0.0.1-e2e.1'
$Ver2 = '0.0.1-e2e.2'
$Mkt = 'nb-e2e'
$Id = "agent-notebook@$Mkt"
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:Out = ''
$script:Rc = 0

function Fail($message) {
  Write-Host "::error::plugin-e2e: $message"
  throw "FAIL: $message"
}
function Step($text) { Write-Host ''; Write-Host "################ $text" }
function Redact([string]$s) { if ($s) { $s.Replace($Work, '<work>') } else { $s } }
function Say($text) { foreach ($line in ([string]$text -split "`r?`n")) { Write-Host (Redact $line) } }
function Quote-Arg([string]$a) {
  if ($a -eq '' -or $a -match '[\s"]') { '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' } else { $a }
}
# Runs a program with an optional PATH of its own and a working folder, no input, a time limit.
function Invoke-Native([string]$Exe, [string[]]$Arguments = @(), [string]$Raw = '', [string]$Cwd = $Work, [string]$Path = '') {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  if ($Raw) { $psi.Arguments = $Raw } else { $psi.Arguments = (($Arguments | ForEach-Object { Quote-Arg $_ }) -join ' ') }
  $psi.WorkingDirectory = $Cwd
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  if ($Path) { $psi.EnvironmentVariables['PATH'] = $Path }
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.StandardInput.Close()
  $o = $p.StandardOutput.ReadToEndAsync()
  $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit(300000)) { $p.Kill(); Fail "$Exe did not finish in 5 minutes" }
  $p.WaitForExit()
  New-Object psobject -Property @{ Code = $p.ExitCode; Out = $o.Result; Err = $e.Result }
}
# Cl <PATH> <cwd> <claude arguments...>: runs claude, prints the command and its output, sets Out and Rc.
function Cl([string]$p, [string]$cwd, [string[]]$a) {
  Write-Host ('$ claude ' + ($a -join ' '))
  $r = Invoke-Native $ClaudeBin $a '' $cwd $p
  $script:Out = ($r.Out + $r.Err).Trim()
  $script:Rc = $r.Code
  if ($script:Out) { Say $script:Out }
  Write-Host "[exit $($script:Rc)]"
}
function Expect-Ok($what) { if ($script:Rc -ne 0) { Fail "$what (exit $($script:Rc))" } }
function Expect-Out($text, $what) { if (-not $script:Out.Contains($text)) { Fail "$what`: the output has no `"$text`"" } }
function Check([string[]]$a) {
  $r = Invoke-Native $NodeBin (@("$Here\check.mjs") + $a)
  Say ($r.Out + $r.Err).Trim()
  if ($r.Code -ne 0) { Fail "check.mjs $($a[0]) failed" }
}
$script:Entry = ''
function Session([string]$label, [string]$p, [string]$cwd, [string]$expect, [string]$ver = '') {
  Write-Host "--- session: $label"
  Write-Host (Redact "`$ claude -p hi --output-format stream-json --verbose   (cwd $cwd, PATH $p)")
  $r = Invoke-Native $ClaudeBin @('-p', 'hi', '--output-format', 'stream-json', '--verbose') '' $cwd $p
  Write-Host "[exit $($r.Code)]"
  [IO.File]::WriteAllText("$Work\session.jsonl", $r.Out, $Utf8)
  $entry = $script:Entry
  if (-not $entry -or -not (Test-Path $entry)) { $entry = "$Art\agent-notebook-plugin-$Ver1\examples\hooks\claude-code\nb-hook-entry.cjs" }
  $a = @("$Here\hookrep.mjs", "$Work\session.jsonl", '--expect', $expect, '--os', 'windows', '--entry', $entry)
  if ($ver) { $a += @('--plugin-version', $ver) }
  $h = Invoke-Native $NodeBin $a
  Say ($h.Out + $h.Err).Trim()
  if ($h.Code -ne 0) { Fail "session '$label': the hooks did not do what was expected (log above)" }
}
function List-Field([string]$field) {
  $r = Invoke-Native $ClaudeBin @('plugin', 'list', '--json') '' $Proj $PNoNode
  [IO.File]::WriteAllText("$Work\list.json", $r.Out, $Utf8)
  $f = Invoke-Native $NodeBin @("$Here\check.mjs", 'installed', "$Work\list.json", $Id, $field)
  $f.Out.Trim()
}

# ---- setup ----
$Art = (Resolve-Path $BuildDir).Path
$Real = [bool]$env:E2E_REAL
if ($Real) {
  $Mkt = if ($env:E2E_MKT) { $env:E2E_MKT } else { 'agent-notebook' }
  $Id = "agent-notebook@$Mkt"
  $vs = @(Get-Content "$Art\versions.txt")
  if ($vs.Count -lt 2) { Fail "$Art is not a check-marketplace --stage folder" }
  $Ver1 = $vs[0].Trim(); $Ver2 = $vs[1].Trim()
  foreach ($f in @('v1.json', 'v2.json', 'bad.json')) { if (-not (Test-Path "$Art\$f")) { Fail "$Art has no $f" } }
  foreach ($v in @($Ver1, $Ver2)) { if (-not (Test-Path "$Art\agent-notebook-plugin-$v")) { Fail "$Art has no agent-notebook-plugin-$v folder" } }
} else {
  foreach ($v in @($Ver1, $Ver2)) {
    if (-not ((Test-Path "$Art\agent-notebook-plugin-$v.zip") -and (Test-Path "$Art\agent-notebook-plugin-$v"))) { Fail "$Art has no agent-notebook-plugin-$v.zip with its staged folder" }
  }
}
$NodeOldDir = $env:NODE_OLD_DIR
if (-not $NodeOldDir -or -not (Test-Path "$NodeOldDir\node.exe")) { Fail 'NODE_OLD_DIR must name the folder of a Node.js 16' }
$ClaudeBin = (Get-Command claude -CommandType Application | Select-Object -First 1).Source
$ClaudeDir = Split-Path $ClaudeBin
$NodeBin = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$NodeDir = Split-Path $NodeBin
Remove-Item Env:\ANTHROPIC_API_KEY, Env:\CLAUDE_CODE_OAUTH_TOKEN, Env:\ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue

$Base = $env:E2E_WORK
if (-not $Base) { $Base = Join-Path $env:RUNNER_TEMP 'nb-e2e' }
if (Test-Path $Base) { Remove-Item -Recurse -Force $Base }
New-Item -ItemType Directory -Force $Base | Out-Null
$Work = (Resolve-Path $Base).Path
$H = Join-Path $Work ('Ana Mar' + [char]0x00ED + 'a')
$Proj = Join-Path $H 'proj'
$Plant = Join-Path $H 'proj-planted'
New-Item -ItemType Directory -Force "$Proj\.claude", $Plant, "$H\.claude", "$H\AppData\Roaming", "$H\AppData\Local" | Out-Null
$env:HOME = $H; $env:USERPROFILE = $H; $env:APPDATA = "$H\AppData\Roaming"; $env:LOCALAPPDATA = "$H\AppData\Local"
$env:CLAUDE_CONFIG_DIR = "$H\.claude"; $env:DISABLE_AUTOUPDATER = '1'

$Sys = "$env:SystemRoot\System32"
$PNoNode = "$ClaudeDir;$Sys;$env:SystemRoot;$Sys\WindowsPowerShell\v1.0"
$POld = "$NodeOldDir;$PNoNode"
$PNew = "$NodeDir;$PNoNode"

$Openssl = (Get-Command openssl -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $Openssl) { foreach ($c in @('C:\Program Files\Git\usr\bin\openssl.exe', 'C:\Program Files\Git\mingw64\bin\openssl.exe')) { if (Test-Path $c) { $Openssl = $c; break } } }
if (-not $Openssl) { Fail 'no openssl.exe found (the runner has one with Git for Windows)' }
$Csc = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

$Hidden = @()
$Server = $null
$Failed = $false
try {
  Write-Host "=== $([Environment]::OSVersion.VersionString), PowerShell $($PSVersionTable.PSVersion), claude $((Invoke-Native $ClaudeBin @('--version')).Out.Trim()), node $((Invoke-Native $NodeBin @('--version')).Out.Trim()), old node $((Invoke-Native "$NodeOldDir\node.exe" @('--version')).Out.Trim())"
  Say "home: $H"

  # ---- the server: https on this computer's own address, a self-signed certificate that names it ----
  Step "serve the two builds over https on the runner's own address"
  $Ip = (Invoke-Native $NodeBin @("$Here\serve.mjs", '--print-ip')).Out.Trim()
  if (-not $Ip) { Fail 'no non-loopback IPv4 address on this computer' }
  $Srv = Join-Path $Work 'srv'
  New-Item -ItemType Directory -Force $Srv | Out-Null
  if (-not $Real) { Copy-Item "$Art\agent-notebook-plugin-$Ver1.zip", "$Art\agent-notebook-plugin-$Ver2.zip" $Srv }
  $fwd = $Work.Replace('\', '/')
  [IO.File]::WriteAllText("$Work\ssl.cnf", ("[req]", "distinguished_name=dn", "x509_extensions=v3", "prompt=no", "[dn]", "CN=nb-e2e", "[v3]", "subjectAltName=IP:$Ip", "") -join "`n", $Utf8)
  $o = Invoke-Native $Openssl @('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', "$fwd/key.pem", '-out', "$fwd/cert.pem", '-days', '2', '-config', "$fwd/ssl.cnf")
  if (-not ((Test-Path "$Work\cert.pem") -and (Test-Path "$Work\key.pem"))) { Fail "openssl could not make the certificate: $($o.Out) $($o.Err)" }
  $serveArgs = (@("$Here\serve.mjs", $Srv, $Ip, '0', "$Work\cert.pem", "$Work\key.pem", "$Work\ready") | ForEach-Object { Quote-Arg $_ }) -join ' '
  $Server = Start-Process -FilePath $NodeBin -ArgumentList $serveArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput "$Work\server.log" -RedirectStandardError "$Work\server.err"
  for ($i = 0; $i -lt 50 -and -not (Test-Path "$Work\ready"); $i++) { Start-Sleep -Milliseconds 200 }
  if (-not (Test-Path "$Work\ready")) { Fail "the server did not start: $(Get-Content "$Work\server.err" -Raw)" }
  $BaseUrl = 'https://' + (Get-Content "$Work\ready" -Raw).Trim()
  Write-Host "serving $BaseUrl (certificate for IP $Ip, 2 days)"
  if ($Real) { Copy-Item "$Art\v1.json", "$Art\v2.json", "$Art\bad.json" $Srv }
  else {
    $m = Invoke-Native $NodeBin @("$Here\mkt.mjs", $Srv, $BaseUrl, $Mkt, "agent-notebook-plugin-$Ver1.zip", "agent-notebook-plugin-$Ver2.zip")
    Say $m.Out
  }
  Copy-Item "$Srv\v1.json" "$Srv\mkt.json"
  $env:NODE_EXTRA_CA_CERTS = "$Work\cert.pem"

  # ---- hide what a user without developer tools would not have ----
  foreach ($d in @('C:\Program Files\Git', 'C:\msys64', 'C:\Program Files\PowerShell')) {
    if (Test-Path $d) { Rename-Item $d ($d + '-nb-e2e-hidden'); $Hidden += $d; Write-Host "hidden: $d" }
  }

  # ---- validate ----
  Step 'claude plugin validate, on the built folder and on the marketplace file'
  Cl $PNoNode $Proj @('plugin', 'validate', "$Art\agent-notebook-plugin-$Ver1")
  Expect-Ok 'validate of the plugin folder'
  [IO.File]::WriteAllText("$Work\validate-plugin.txt", $script:Out, $Utf8); Check @('validate', "$Work\validate-plugin.txt")
  Cl $PNoNode $Proj @('plugin', 'validate', "$Srv\mkt.json")
  Expect-Ok 'validate of the marketplace file'
  [IO.File]::WriteAllText("$Work\validate-mkt.txt", $script:Out, $Utf8); Check @('validate', "$Work\validate-mkt.txt")

  # ---- a wrong checksum is refused (in a separate Claude Code folder) ----
  Step 'a marketplace entry with a wrong sha256 is refused'
  $saved = $env:CLAUDE_CONFIG_DIR
  $env:CLAUDE_CONFIG_DIR = "$Work\bad-config"; New-Item -ItemType Directory -Force $env:CLAUDE_CONFIG_DIR | Out-Null
  Cl $PNoNode $Proj @('plugin', 'install', 'agent-notebook', '--marketplace', "$BaseUrl/bad.json")
  if ($script:Rc -eq 0) { Fail 'a plugin with a wrong sha256 was installed' }
  Expect-Out 'integrity check failed' 'the wrong sha256'
  $env:CLAUDE_CONFIG_DIR = $saved

  # ---- before: the settings files, seeded so that an overwrite would show ----
  Step 'settings before the install'
  [IO.File]::WriteAllText("$H\.claude\settings.json", "{`n  `"cleanupPeriodDays`": 30,`n  `"env`": { `"NB_E2E_SEED`": `"1`" }`n}`n", $Utf8)
  [IO.File]::WriteAllText("$Proj\.claude\settings.json", "{`n  `"env`": { `"NB_E2E_PROJECT_SEED`": `"1`" }`n}`n", $Utf8)
  Check @('snapshot', "$Work\settings-before.json", "$H\.claude", "$Proj\.claude")

  # ---- install ----
  Step 'install from the marketplace, with no node and no git on PATH'
  Cl $PNoNode $Proj @('plugin', 'install', 'agent-notebook', '--marketplace', "$BaseUrl/mkt.json")
  Expect-Ok 'install'
  Expect-Out "Successfully installed plugin: $Id" 'install'
  if ((List-Field 'version') -ne $Ver1) { Fail "the installed version is not $Ver1" }
  $Root = List-Field 'installPath'
  Say "installed at: $Root"
  Check @('same-tree', "$Art\agent-notebook-plugin-$Ver1", $Root)
  $script:Entry = "$Root\examples\hooks\claude-code\nb-hook-entry.cjs"
  if (-not (Test-Path $script:Entry)) { Fail 'the installed plugin has no hook entry' }
  # A file that came from the internet carries a Zone.Identifier stream, and PowerShell then refuses to run it.
  $zoned = @(Get-ChildItem -Recurse -Force $Root | Where-Object { -not $_.PSIsContainer } | Where-Object { Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue })
  if ($zoned.Count -gt 0) { Fail "Zone.Identifier on $($zoned[0].FullName)" }
  Write-Host 'ok: no installed file has a Zone.Identifier stream'

  # ---- sessions ----
  Step 'sessions of the installed plugin: no node, Node.js 16, a current Node.js'
  Session 'no node on PATH' $PNoNode $Proj 'nonode' $Ver1
  Session 'Node.js 16 on PATH' $POld $Proj 'oldnode' $Ver1
  Session 'current Node.js on PATH' $PNew $Proj 'newnode-first' $Ver1
  if (-not (Test-Path (Join-Path $H '.agent-notebook\projects\.first-start'))) { Fail 'the first chat left no .first-start claim' }

  # ---- planted programs ----
  Step 'programs planted in the project folder never run'
  New-Item -ItemType Directory -Force "$Work\bin" | Out-Null
  $c = Invoke-Native $Csc @('/nologo', "/out:$Work\bin\planted.exe", "$Here\planted.cs")
  if (-not (Test-Path "$Work\bin\planted.exe")) { Fail "csc could not build planted.cs: $($c.Out) $($c.Err)" }
  foreach ($n in @('node.exe', 'powershell.exe', 'where.exe', 'cmd.exe')) { Copy-Item "$Work\bin\planted.exe" "$Plant\$n" }
  [IO.File]::WriteAllText("$Plant\node.cmd", "@echo PLANTED-NODE-CMD`r`n", $Utf8)
  Session 'planted node.exe, node.cmd, powershell.exe, where.exe, cmd.exe; no node' $PNoNode $Plant 'nonode' $Ver1
  Session 'planted, Node.js 16' $POld $Plant 'oldnode' $Ver1
  Session 'planted, current Node.js' $PNew $Plant 'newnode' $Ver1
  $nbCmd = "$Root\bin\nb.cmd"
  foreach ($pp in @($PNew, "$PNew;")) {
    Write-Host (Redact "`$ (cd <project folder with planted node.exe, node.cmd, cmd.exe, ...>; cmd /d /s /c nb.cmd --version)   PATH=$pp")
    $r = Invoke-Native "$Sys\cmd.exe" @() "/d /s /c `"`"$nbCmd`" --version`"" $Plant $pp
    $txt = ($r.Out + $r.Err).Trim()
    Say $txt; Write-Host "[exit $($r.Code)]"
    if ($r.Code -ne 0) { Fail 'nb.cmd --version failed' }
    if ($txt.Contains('PLANTED')) { Fail 'nb.cmd ran a planted program' }
    if (-not $txt.Contains($Ver1)) { Fail "nb.cmd --version did not print $Ver1" }
  }

  # ---- a lesson with every character that a command line can mangle ----
  Step 'a lesson added through the skill form is read back byte for byte'
  $text = '100% %APPDATA% & a | b ^ c ' + [char]0x00E9 + " 'x' " + '$y'
  $nbDir = Join-Path $H 'nbdir'
  $env:NB_DIR = $nbDir
  $savedPath = $env:PATH
  $env:PATH = $PNew
  Push-Location $Plant
  try {
    $OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
    $text | & $nbCmd add t -
    if ($LASTEXITCODE -ne 0) { Fail "nb.cmd add exited $LASTEXITCODE" }
    $shown = (& $nbCmd show t --json) -join "`n"
  } finally { Pop-Location; $env:PATH = $savedPath; Remove-Item Env:\NB_DIR }
  [IO.File]::WriteAllText("$Work\lesson.txt", $text, $Utf8)
  [IO.File]::WriteAllText("$Work\show.json", $shown, $Utf8)
  Check @('lesson', $nbDir, 't', "$Work\lesson.txt", "$Work\show.json")

  if ($Ver1 -ne $Ver2) {
  # ---- update ----
  Step "update: the marketplace now names $Ver2"
  Copy-Item "$Srv\v2.json" "$Srv\mkt.json" -Force
  Cl $PNoNode $Proj @('plugin', 'marketplace', 'update', $Mkt); Expect-Ok 'marketplace update'
  Cl $PNoNode $Proj @('plugin', 'update', $Id); Expect-Ok 'plugin update'
  Expect-Out "updated from $Ver1 to $Ver2" 'update'
  if ((List-Field 'version') -ne $Ver2) { Fail "the installed version is not $Ver2 after the update" }
  Check @('same-tree', "$Art\agent-notebook-plugin-$Ver2", (List-Field 'installPath'))
  Session 'after the update' $PNew $Proj 'newnode' $Ver2

  # ---- rollback ----
  Step "rollback: the marketplace names $Ver1 again"
  Copy-Item "$Srv\v1.json" "$Srv\mkt.json" -Force
  Cl $PNoNode $Proj @('plugin', 'marketplace', 'update', $Mkt); Expect-Ok 'marketplace update'
  Cl $PNoNode $Proj @('plugin', 'update', $Id); Expect-Ok 'plugin update'
  Expect-Out "updated from $Ver2 to $Ver1" 'rollback'
  if ((List-Field 'version') -ne $Ver1) { Fail "the installed version is not $Ver1 after the rollback" }
  Session 'after the rollback' $PNew $Proj 'newnode' $Ver1
  }

  # ---- uninstall ----
  Step 'uninstall'
  Cl $PNoNode $Proj @('plugin', 'uninstall', $Id); Expect-Ok 'uninstall'
  if ((List-Field 'version') -ne 'absent') { Fail 'the plugin is still listed after the uninstall' }
  Session 'after the uninstall' $PNew $Proj 'none'

  Step "settings after the uninstall: only Claude Code's own keys may differ"
  Check @('snapshot', "$Work\settings-after.json", "$H\.claude", "$Proj\.claude")
  Check @('settings-diff', "$Work\settings-before.json", "$Work\settings-after.json", $Mkt)

  Write-Host ''
  Write-Host 'plugin-e2e on Windows: all checks passed'
} catch {
  $Failed = $true
  Write-Host "FAIL: $($_.Exception.Message)"
  Write-Host $_.ScriptStackTrace
} finally {
  foreach ($d in $Hidden) { if (Test-Path ($d + '-nb-e2e-hidden')) { Rename-Item ($d + '-nb-e2e-hidden') (Split-Path $d -Leaf) } }
  if ($Server) { Stop-Process -Id $Server.Id -Force -ErrorAction SilentlyContinue }
  if (Test-Path "$Work\server.log") { Write-Host ''; Write-Host '--- server log'; Say (Get-Content "$Work\server.log" -Raw) }
}
if ($Failed) { exit 1 }
