// build-v1.mjs <outdir> <version>...: assemble the design-v1 plugin zip(s) with our own writer. node:* only.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './zipw.mjs';
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const [out, ...versions] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const NOTICE = 'agent-notebook: Node.js 18 or later is needed; it is missing or too old here, so the notebook is off. Tell the user: install the LTS version from https://nodejs.org, then quit and reopen Claude Code.';
const entryPath = '${CLAUDE_PLUGIN_ROOT}/examples/hooks/claude-code/nb-hook-entry.cjs';
const nodeHook = (ev) => ({ type: 'command', command: 'node', args: [entryPath, ev] });
const hooks = { hooks: {
  SessionStart: [{ hooks: [ nodeHook('session-start'),
    { type: 'command', command: 'sh', args: ['-c', 'case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0;; esac; command -v node >/dev/null 2>&1 || echo \'' + NOTICE + '\''] },
    { type: 'command', command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', "if (-not $env:CLAUDE_PLUGIN_ROOT) { exit 0 }; if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) { Write-Output '" + NOTICE + "' }"] } ] }],
  SubagentStart: [{ hooks: [nodeHook('subagent-start')] }],
  Stop: [{ hooks: [nodeHook('stop')] }] } };
const NB = '#!/bin/sh\n# drop empty and relative PATH entries, so a node planted in the current folder is never run [E1]\np=; IFS=:; for d in $PATH; do case $d in /*) p=${p:+$p:}$d;; esac; done; unset IFS\nPATH=$p exec node "$(dirname "$0")/../dist/cli.js" "$@"\n';
const NBCMD = ['@echo off', 'setlocal', 'set NoDefaultCurrentDirectoryInExePath=1', 'node "%~dp0..\\dist\\cli.js" %*', 'exit /b %errorlevel%', ''].join('\r\n');
function walk(d, acc = []) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p, acc) : acc.push(p); } return acc; }
const dist = walk(join(ROOT, 'dist')).filter((p) => p.endsWith('.js'));
for (const v of versions) {
  const E = (name, data, mode = 0o100644) => ({ name, data: Buffer.from(data), mode });
  const es = [
    E('.claude-plugin/plugin.json', JSON.stringify({ name: 'agent-notebook', version: v, description: 'Agent notebook: lessons that carry from one task to the next.', author: { name: 'agent-notebook' }, license: 'MIT' }, null, 2) + '\n'),
    E('package.json', JSON.stringify({ name: 'agent-notebook', version: v, type: 'module', engines: { node: '>=18' }, license: 'MIT' }, null, 2) + '\n'),
    E('LICENSE', readFileSync(join(ROOT, 'LICENSE'))),
    E('bin/nb', NB, 0o100755), E('bin/nb.cmd', NBCMD),
    E('hooks/hooks.json', JSON.stringify(hooks, null, 2) + '\n'),
    E('skills/agent-notebook/SKILL.md', readFileSync(join(HERE, 'SKILL.md'), 'utf8').replace(/\{\{VERSION\}\}/g, v)),
    E('examples/hooks/claude-code/nb-claude-hook.mjs', readFileSync(join(ROOT, 'examples/hooks/claude-code/nb-claude-hook.mjs'))),
    E('examples/hooks/claude-code/nb-hook-entry.cjs', readFileSync(join(HERE, 'nb-hook-entry.cjs'))),
    ...dist.map((p) => { const n = relative(ROOT, p).split(sep).join('/'); return E(n, readFileSync(p), n === 'dist/cli.js' ? 0o100755 : 0o100644); }),
  ];
  const z = zip(es), name = `plugin-${v}.zip`;
  writeFileSync(join(out, name), z);
  console.log(createHash('sha256').update(z).digest('hex') + '  ' + name + '  (' + es.length + ' entries, ' + z.length + ' bytes)');
}
