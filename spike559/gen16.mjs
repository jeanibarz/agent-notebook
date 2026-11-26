// gen16.mjs <outdir>: plugin variants carrying the final node-check file, differing in how hooks.json invokes it.
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
const out = process.argv[2];
const NOTICE = 'agent-notebook: the notebook needs Node.js 18 or later, which this computer does not have yet. Tell the user, in plain words: Node.js is a free program, download the LTS version from https://nodejs.org and install it, then quit Claude Code completely, with Cmd+Q on a Mac or by closing every terminal window on Windows, and open it again. Until then the notebook is off.';
const FINAL = [":; command -v node >/dev/null 2>&1 || echo '" + NOTICE + "'; exit 0 #", '@echo off', 'setlocal', 'set NoDefaultCurrentDirectoryInExePath=1', '"%SystemRoot%\\System32\\where.exe" $PATH:node.exe >nul 2>nul || echo ' + NOTICE, 'exit /b 0', ''].join('\r\n');
const P = '${CLAUDE_PLUGIN_ROOT}/hooks/nb-node-check.cmd';
const V = {
  U: [FINAL, { type: 'command', command: P }],
  Q: [FINAL, { type: 'command', command: '"' + P + '"' }],
  X: ['#!/bin/sh\n' + FINAL, { type: 'command', command: P, args: [] }],
  N: [FINAL, { type: 'command', command: P, args: [] }],
  C: [FINAL, { type: 'command', command: 'cmd.exe', args: ['/d', '/c', '${CLAUDE_PLUGIN_ROOT}\\hooks\\nb-node-check.cmd'] }],
};
for (const [k, [body, hook]] of Object.entries(V)) {
  const d = join(out, 'v-' + k); mkdirSync(join(d, '.claude-plugin'), { recursive: true }); mkdirSync(join(d, 'hooks'), { recursive: true });
  writeFileSync(join(d, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'x16b', version: '1.0.0', description: 'x16b', author: { name: 't' } }));
  const f = join(d, 'hooks', 'nb-node-check.cmd'); writeFileSync(f, Buffer.from(body, 'utf8')); chmodSync(f, 0o755);
  writeFileSync(join(d, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [hook] }] } }, null, 2));
}
