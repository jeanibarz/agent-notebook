# X16 on Windows: home "Ana Maria" (accented), planted where.exe / where.cmd / cmd.exe in the project folder.
$ErrorActionPreference = 'Continue'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeDir = Join-Path $env:USERPROFILE '.local\bin'; $W = Join-Path $env:RUNNER_TEMP 'w559'
$H = (Get-Content (Join-Path $W 'x16home.txt') -Raw -Encoding UTF8).Trim()
$env:PATH = "$ClaudeDir;$env:PATH"; $Real = $env:PATH
$env:USERPROFILE = $H; $env:HOME = $H; $env:APPDATA = "$H\AppData\Roaming"; $env:LOCALAPPDATA = "$H\AppData\Local"; $env:CLAUDE_CONFIG_DIR = "$H\.claude"; $env:DISABLE_AUTOUPDATER = '1'
"home: $H"
$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'; New-Item -ItemType Directory -Force "$W\bin" | Out-Null
& $Csc /nologo /out:"$W\bin\planted.exe" "$Here\planted.cs" | Out-Null
$Min = "$ClaudeDir;C:\Windows\System32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0"
$Git = 'C:\Program Files\Git'
function Run($label, $path, $plant) {
  "== $label (planted: $(if ($plant) { 'where.exe, where.cmd, cmd.exe' } else { 'none' }))"
  $d = Join-Path $H "p-$([guid]::NewGuid().ToString('N').Substring(0,6))"; New-Item -ItemType Directory -Force $d | Out-Null; Set-Location $d
  if ($plant) { Copy-Item "$W\bin\planted.exe" "$d\where.exe"; Copy-Item "$W\bin\planted.exe" "$d\cmd.exe"; Set-Content -Encoding ASCII "$d\where.cmd" '@echo PLANTED-WHERE-CMD' }
  $env:PATH = $path; $f = Join-Path $H 'o.jsonl'
  $null | & claude -p hi --output-format stream-json --verbose 2>$null | Out-File -Encoding utf8 $f
  $env:PATH = $Real; & node "$Here\x16rep.mjs" $f
}
Run 'node present, git present' $Real $false
Run 'node present, git present' $Real $true
Run 'node absent, git on PATH' "$Min;$Git\cmd;$Git\usr\bin;$Git\bin" $false
Run 'node absent, git on PATH' "$Min;$Git\cmd;$Git\usr\bin;$Git\bin" $true
Run 'node absent, no git on PATH' $Min $false
Run 'node absent, no git on PATH' $Min $true
exit 0
