// gen13.mjs <outdir>: plugin variants carrying one polyglot node-check hook (X13). Exact bytes, so LF/CRLF are deliberate.
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
const out = process.argv[2];
const N = 'agent-notebook: Node.js 18 or later is needed; it is missing or too old here, so the notebook is off. Tell the user: install the LTS version from https://nodejs.org, then quit and reopen Claude Code.';
const sh = `:; command -v node >/dev/null 2>&1 || echo '${N}'; exit 0`;
const shc = `${sh} #`;
const bat = ['@echo off', 'setlocal', `where $PATH:node.exe >nul 2>nul || echo ${N}`, 'exit /b 0'];
const V = {
  'a-lf': ['\n', [sh, ...bat]],
  'b-crlf': ['\r\n', [sh, ...bat]],
  'c-shebang-lf': ['\n', ['#!/bin/sh', sh, ...bat]],
  'd-shebang-crlf': ['\r\n', ['#!/bin/sh', sh, ...bat]],
  'e-crlf-comment': ['\r\n', [shc, ...bat]],
  'f-shebang-crlf-comment': ['\r\n', ['#!/bin/sh', shc, ...bat]],
};
const hook = (command, args) => JSON.stringify({ hooks: { SessionStart: [{ hooks: [args ? { type: 'command', command, args } : { type: 'command', command }] }] } }, null, 2);
for (const [name, [eol, lines]] of Object.entries(V)) {
  for (const form of ['plain', 'cmdexe']) {
    const d = join(out, `${name}--${form}`); mkdirSync(join(d, '.claude-plugin'), { recursive: true }); mkdirSync(join(d, 'hooks'), { recursive: true });
    writeFileSync(join(d, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'x13', version: '1.0.0', description: 'x13', author: { name: 't' } }));
    const f = join(d, 'hooks', 'nb-node-check.cmd'); writeFileSync(f, lines.join(eol) + eol); chmodSync(f, 0o755);
    writeFileSync(join(d, 'hooks', 'hooks.json'), form === 'plain' ? hook('${CLAUDE_PLUGIN_ROOT}/hooks/nb-node-check.cmd') : hook('cmd.exe', ['/d', '/c', '${CLAUDE_PLUGIN_ROOT}\\hooks\\nb-node-check.cmd']));
  }
}
