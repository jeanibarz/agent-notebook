# X16b Windows: variants U/Q/X/N/C in a root named "Ana Maria" (accented), Git present and hidden, planted where.exe/where.cmd/cmd.exe.
$ErrorActionPreference = 'Continue'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeDir = Join-Path $env:USERPROFILE '.local\bin'; $W = Join-Path $env:RUNNER_TEMP 'w559'
$env:PATH = "$ClaudeDir;$env:PATH"; $Real = $env:PATH
$Name = 'Ana Mar' + [char]0x00ED + 'a'; $Root = Join-Path (Join-Path $W 'x16bw') $Name
& node "$Here\gen16.mjs" $Root
$H = Join-Path $W 'x16bhome'; New-Item -ItemType Directory -Force $H | Out-Null
$env:USERPROFILE = $H; $env:HOME = $H; $env:APPDATA = "$H\AppData\Roaming"; $env:LOCALAPPDATA = "$H\AppData\Local"; $env:CLAUDE_CONFIG_DIR = "$H\.claude"; $env:DISABLE_AUTOUPDATER = '1'
$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'; New-Item -ItemType Directory -Force "$W\bin" | Out-Null
& $Csc /nologo /out:"$W\bin\planted.exe" "$Here\planted.cs" | Out-Null
$Min = "$ClaudeDir;C:\Windows\System32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0"
$Git = 'C:\Program Files\Git'
function Run($label, $v, $path, $plant) {
  "== $label | variant $v | planted: $(if ($plant) { 'where.exe where.cmd cmd.exe' } else { 'none' })"
  $d = Join-Path $H "p-$([guid]::NewGuid().ToString('N').Substring(0,6))"; New-Item -ItemType Directory -Force $d | Out-Null; Set-Location $d
  if ($plant) { Copy-Item "$W\bin\planted.exe" "$d\where.exe"; Copy-Item "$W\bin\planted.exe" "$d\cmd.exe"; Set-Content -Encoding ASCII "$d\where.cmd" '@echo PLANTED-WHERE-CMD' }
  $env:PATH = $path; $f = Join-Path $H 'o.jsonl'
  $null | & claude -p hi --plugin-dir (Join-Path $Root "v-$v") --output-format stream-json --verbose 2>$null | Out-File -Encoding utf8 $f
  $env:PATH = $Real; & node "$Here\x16rep.mjs" $f
}
foreach ($gitState in 'git present', 'git hidden') {
  if ($gitState -eq 'git hidden') { Rename-Item $Git ($Git + '-hidden16'); "hidden Git: $(-not (Test-Path $Git))" }
  $abs = if ($gitState -eq 'git present') { "$Min;$Git\cmd;$Git\usr\bin;$Git\bin" } else { $Min }
  $pres = $Real
  foreach ($v in 'U','Q','X','N','C') {
    Run "$gitState, node present" $v $pres $false
    Run "$gitState, node absent" $v $abs $false
  }
  foreach ($v in 'Q','X','N','C') { Run "$gitState, node absent" $v $abs $true }
  foreach ($v in 'Q','N','C') { Run "$gitState, node present" $v $pres $true }
}
exit 0
