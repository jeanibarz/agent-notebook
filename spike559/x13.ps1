# X13 on Windows: polyglot node-check hook variants, plain exec and cmd.exe forms; node present/absent, Git Bash present/absent, planted node.exe.
$ErrorActionPreference = 'Continue'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeDir = Join-Path $env:USERPROFILE '.local\bin'; $W = Join-Path $env:RUNNER_TEMP 'w559'; $G = Join-Path $W 'x13'
$env:PATH = "$ClaudeDir;$env:PATH"; $Real = $env:PATH
$H = Join-Path $W 'x13home'; New-Item -ItemType Directory -Force $H | Out-Null
& node "$Here\gen13.mjs" $G
$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'; New-Item -ItemType Directory -Force "$W\bin" | Out-Null
& $Csc /nologo /out:"$W\bin\planted.exe" "$Here\planted.cs" | Out-Null
$env:USERPROFILE = $H; $env:HOME = $H; $env:APPDATA = "$H\AppData\Roaming"; $env:LOCALAPPDATA = "$H\AppData\Local"; $env:CLAUDE_CONFIG_DIR = "$H\.claude"; $env:DISABLE_AUTOUPDATER = '1'
$Min = "$ClaudeDir;C:\Windows\System32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0"
$Git = 'C:\Program Files\Git'
"git bash present: $(Test-Path "$Git\bin\bash.exe")"
function Run($label, $dirname, $path, $plant) {
  "== $label  [$dirname]"; $d = Join-Path $H "p-$([guid]::NewGuid().ToString('N').Substring(0,6))"; New-Item -ItemType Directory -Force $d | Out-Null; Set-Location $d
  if ($plant) { Copy-Item "$W\bin\planted.exe" "$d\node.exe" }
  $env:PATH = $path; $f = Join-Path $H 'o.jsonl'
  $null | & claude -p hi --plugin-dir (Join-Path $G $dirname) --output-format stream-json --verbose 2>$null | Out-File -Encoding utf8 $f
  $env:PATH = $Real; & node "$Here\hookrep.mjs" $f | Where-Object { $_ -notmatch '^INIT' }
}
foreach ($v in 'a-lf','b-crlf','c-shebang-lf','d-shebang-crlf','e-crlf-comment','f-shebang-crlf-comment') {
  Run "$v node present, git present" "$v--plain" $Real $false
  Run "$v node absent, git on PATH" "$v--plain" "$Min;$Git\cmd;$Git\usr\bin;$Git\bin" $false
  Run "$v node absent, no git on PATH" "$v--plain" $Min $false
}
# best variants only for the rest
foreach ($v in 'a-lf','b-crlf') {
  Run "$v CMDEXE FORM node absent, no git" "$v--cmdexe" $Min $false
  Run "$v CMDEXE FORM node present" "$v--cmdexe" $Real $false
  Run "$v PLAIN planted node.exe, node absent" "$v--plain" $Min $true
  Run "$v PLAIN planted node.exe, node present" "$v--plain" $Real $true
}
exit 0
