# X9 on Windows: sessions with node 24 / absent / old, and nb.cmd from the zip.
$ErrorActionPreference = 'Continue'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeDir = Join-Path $env:USERPROFILE '.local\bin'; $W = Join-Path $env:RUNNER_TEMP 'w559'; $H = Join-Path $W 'x9'
$env:PATH = "$ClaudeDir;$env:PATH"; $Real = $env:PATH; $NodeDir = Split-Path (Get-Command node).Source
$env:USERPROFILE = $H; $env:HOME = $H; $env:APPDATA = "$H\AppData\Roaming"; $env:LOCALAPPDATA = "$H\AppData\Local"; $env:CLAUDE_CONFIG_DIR = "$H\.claude"; $env:DISABLE_AUTOUPDATER = '1'
$Root = (Get-ChildItem "$H\.claude\plugins\cache\nbloop\agent-notebook" | Select-Object -First 1).FullName
"plugin dir: $Root"; Get-ChildItem -Recurse $Root | Where-Object { -not $_.PSIsContainer } | ForEach-Object { $z = Get-Item -Path $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue; if ($z) { "ZONE.IDENTIFIER on $($_.FullName)" } }
"files in plugin: $((Get-ChildItem -Recurse $Root | Where-Object { -not $_.PSIsContainer }).Count); nb.cmd CRLF bytes: $((Get-Content -Raw "$Root\bin\nb.cmd").Split([char]13).Count - 1)"
$Min = "$ClaudeDir;C:\Windows\System32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0"
function Sess($label, $path) {
  "== $label"; $d = Join-Path $H "p-$label"; New-Item -ItemType Directory -Force $d | Out-Null; Set-Location $d
  $env:PATH = $path; $f = Join-Path $H 'o.jsonl'
  $null | & claude -p hi --output-format stream-json --verbose 2>$null | Out-File -Encoding utf8 $f
  $env:PATH = $Real; $o = & node "$Here\hookrep.mjs" $f
  $o | Where-Object { $_ -notmatch 'SPIKE559' }
  "index lines: $(@($o | Select-String 'Your agent-notebook index').Count)  notice lines: $(@($o | Select-String 'Node.js 18 or later is needed').Count)"
}
Sess 'node24' $Real
Sess 'nonode' $Min
if ($env:NODE_OLD_DIR) { Sess 'node16' "$env:NODE_OLD_DIR;$Min" }
"== nb.cmd from the zip, planted node.exe/node.cmd in cwd"
$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'; New-Item -ItemType Directory -Force "$W\bin" | Out-Null
& $Csc /nologo /out:"$W\bin\planted.exe" "$Here\planted.cs" | Out-Null
foreach ($sc in @(@('none'), @('node.exe'), @('node.cmd'))) {
  $d = Join-Path $H ("nb-" + ($sc -join '-')); New-Item -ItemType Directory -Force $d | Out-Null; Set-Location $d
  if ($sc -contains 'node.exe') { Copy-Item "$W\bin\planted.exe" "$d\node.exe" }
  if ($sc -contains 'node.cmd') { Set-Content -Encoding ASCII "$d\node.cmd" '@echo PLANTED-NODE-CMD' }
  $o = & cmd.exe /c "`"$Root\bin\nb.cmd`" --version" 2>&1
  "planted=[$($sc -join ',')] nb.cmd -> $(($o | Out-String).Trim() -replace '\r?\n', ' / ')"
}

"################ X14: argument fidelity through nb.cmd, Windows PowerShell $($PSVersionTable.PSVersion)"
$Nb = "$Root\bin\nb.cmd"
$Sq = [string][char]39; $U = [string][char]0x00E9
$text = '100% %APPDATA% & a | b ^ c ' + $U + ' ' + $Sq + 'x' + $Sq + ' $y `z'
function Show($label, $nbdir) {
  $f = Get-ChildItem $nbdir -Filter 't.md' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $f) { "$label -> NO FILE STORED"; return }
  $bytes = [IO.File]::ReadAllBytes($f.FullName); $str = [Text.Encoding]::UTF8.GetString($bytes)
  $line = ($str -split "`n" | Where-Object { $_ -match 'a \|' } | Select-Object -First 1)
  $ok = $str.Contains($text)
  "$label -> byte-equal to the original text: $ok"
  "   stored line: $line"
  if (-not $ok) { "   hex of stored line: " + (([Text.Encoding]::UTF8.GetBytes([string]$line) | ForEach-Object { $_.ToString('x2') }) -join '') }
}
function Fresh($n) { $d = Join-Path $H "nbd-$n"; Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $d | Out-Null; $env:NB_DIR = $d; $d }
"text = [$text]"
$d = Fresh 1; & $Nb add t "100% %APPDATA% & a | b ^ c $U 'x' `$y ``z" 2>&1 | Out-String | ForEach-Object { "out: $($_.Trim())" }; Show 'argv, double-quoted' $d
$d = Fresh 2; & $Nb add t ('100% %APPDATA% & a | b ^ c ' + $U + ' ''x'' $y `z') 2>&1 | Out-String | ForEach-Object { "out: $($_.Trim())" }; Show 'argv, single-quoted' $d
$d = Fresh 3; $text | & $Nb add t - 2>&1 | Out-String | ForEach-Object { "out: $($_.Trim())" }; Show 'stdin, default encoding' $d
$d = Fresh 4; $OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $text | & $Nb add t - 2>&1 | Out-String | ForEach-Object { "out: $($_.Trim())" }; Show 'stdin, UTF-8 OutputEncoding' $d
$d = Fresh 5; & $Nb add t "plain ascii lesson" | Out-Null; & $Nb show t 2>&1 | Out-String | ForEach-Object { "show: $($_.Trim())" }
"--- bare nb from PowerShell with both bin\nb and bin\nb.cmd on PATH"
$env:PATH = "$Root\bin;$Real"; $env:NB_DIR = (Fresh 6)
"Get-Command nb -All:"; Get-Command nb -All | ForEach-Object { "  $($_.CommandType) $($_.Source)" }
"nb --version -> $((& nb --version 2>&1 | Out-String).Trim())"
$env:PATH = $Real
exit 0
