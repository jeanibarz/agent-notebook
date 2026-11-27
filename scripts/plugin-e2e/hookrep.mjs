// Reads one `claude -p ... --output-format stream-json --verbose` log of the plugin
// end-to-end test (issue #559), prints what the SessionStart hooks did, and checks it.
//
//   node hookrep.mjs <stream.jsonl> --expect <mode> --os <posix|windows> --entry <nb-hook-entry.cjs>
//                    [--plugin-version <v>] [--plugin-root-contains <text>]
//
// <mode> says what the session was started with:
//   nonode   no Node.js on PATH     exactly one notice, from the twin of this OS
//   oldnode  Node.js 16 on PATH     exactly one notice, from the entry
//   newnode  Node.js 22 or later    the notebook index, and no notice
//   newnode-first  the same, in the first chat of a new home (issue #560): exactly one set-up note,
//            then the notebook index, in one output
//   none     the plugin is not installed: no hook of ours ran and Claude Code does not list it
//
// The notice is read from the installed entry file, so that this check follows the entry's
// text instead of keeping a third copy of it. The plugin lists three SessionStart hooks: the
// entry (node), and the twins for POSIX (sh) and for Windows (powershell.exe). Each system
// can start only two of them, so one hook per session ends with "Executable not found". That
// is the known cost of the twin pair, and the only error allowed here.
//
// It exits 1 and says why on the first miss, 2 when called wrongly.
import { readFileSync } from 'node:fs';

function usage(message) {
  console.error(`hookrep: ${message}`);
  console.error('usage: node hookrep.mjs <stream.jsonl> --expect nonode|oldnode|newnode|newnode-first|none --os posix|windows --entry <file> [--plugin-version V] [--plugin-root-contains TEXT]');
  process.exit(2);
}

const args = process.argv.slice(2);
const file = args.shift();
const opt = {};
while (args.length) {
  const key = args.shift();
  if (!key.startsWith('--') || args.length === 0) usage(`bad argument ${key}`);
  opt[key.slice(2)] = args.shift();
}
if (!file || !['nonode', 'oldnode', 'newnode', 'newnode-first', 'none'].includes(opt.expect) || !['posix', 'windows'].includes(opt.os) || !opt.entry) usage('missing or bad argument');

const entryText = readFileSync(opt.entry, 'utf-8');
const notice = /^var NOTICE = '(.*)';\r?$/m.exec(entryText)?.[1];
if (!notice) usage(`no "var NOTICE = '...';" line in ${opt.entry}`);

const events = [];
for (const line of readFileSync(file, 'utf-8').replace(/^﻿/, '').split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    events.push(JSON.parse(line));
  } catch {
    fail(`a line of the stream is not JSON: ${line.slice(0, 120)}`);
  }
}

function fail(message) {
  console.log(`FAIL: ${message}`);
  process.exit(1);
}
const clip = (s) => String(s ?? '').slice(0, 100).replace(/\r?\n/g, '\\n');

const init = events.find((e) => e.subtype === 'init');
if (!init) fail('the stream has no init event: Claude Code did not start a session');
const plugin = (init.plugins ?? []).find((p) => p.name === 'agent-notebook');
console.log(`init: agent-notebook plugin = ${plugin ? `${plugin.version} at ${plugin.path}` : 'not loaded'}`);

const responses = events.filter((e) => e.subtype === 'hook_response' && e.hook_event === 'SessionStart');
for (const e of responses) console.log(`hook SessionStart exit ${e.exit_code} ${e.outcome} | stdout: ${clip(e.stdout)} | stderr: ${clip(e.stderr)}`);

// Nothing of the plugin may ever run a planted program (the other end-to-end checks plant them).
const planted = events.filter((e) => JSON.stringify(e).includes('PLANTED'));
if (planted.length) fail(`a planted program ran: ${clip(JSON.stringify(planted[0]))}`);

if (opt.expect === 'none') {
  if (plugin) fail('Claude Code still loads the agent-notebook plugin');
  if (responses.length) fail(`${responses.length} SessionStart hook(s) ran, and none was expected`);
  console.log('ok: no plugin, no hook');
  process.exit(0);
}

if (!plugin) fail('Claude Code did not load the agent-notebook plugin');
if (opt['plugin-version'] && (plugin.version !== opt['plugin-version'] || !plugin.path.replace(/[\\/]+$/, '').endsWith(opt['plugin-version']))) {
  fail(`the session loads the plugin ${plugin.version} from ${plugin.path}, expected the ${opt['plugin-version']} folder`);
}
if (responses.length !== 3) fail(`${responses.length} SessionStart hook responses, expected the plugin's 3`);

// The one hook per session that cannot start. nonode: `node` cannot start either.
const unstartable = opt.os === 'posix' ? ['powershell.exe'] : ['sh'];
if (opt.expect === 'nonode') unstartable.push('node');
const isMissing = (e) => {
  const m = /Executable not found in \$PATH: "([^"]+)"/.exec(String(e.stderr ?? ''));
  return m ? m[1] : null;
};
const failed = responses.filter((e) => e.exit_code !== 0);
const missing = failed.map(isMissing).sort();
if (failed.length !== unstartable.length || missing.join() !== [...unstartable].sort().join()) {
  fail(`the hooks that failed were [${failed.map((e) => isMissing(e) ?? `exit ${e.exit_code}: ${clip(e.stderr)}`)}], expected exactly the missing [${unstartable}]`);
}
if (failed.some((e) => e.stdout !== '')) fail('a hook that failed printed on stdout');

// The hooks that ran: the entry's output and the twin's exit code 0.
const ran = responses.filter((e) => e.exit_code === 0);
const noticeEvents = events.filter((e) => JSON.stringify(e).includes(notice));
const noticeLines = ran.filter((e) => e.stdout.split(/\r?\n/).includes(notice));
const INDEX = '## Your agent-notebook index';
const NOTE = '## Set-up note from the agent-notebook program';
const index = ran.filter((e) => e.stdout.startsWith(INDEX));
// The first chat of a new home: the set-up note comes first, then the index, in the same output.
const first = ran.filter((e) => e.stdout.startsWith(NOTE + '\n') && e.stdout.includes('\n' + INDEX));

if (opt.expect === 'newnode' || opt.expect === 'newnode-first') {
  if (noticeEvents.length) fail('a Node.js notice appeared in a session that has Node.js 22 or later');
  if (opt.expect === 'newnode-first') {
    if (first.length !== 1 || ran.some((e) => e.stdout.split(NOTE).length - 1 > 1) || index.length) fail(`${first.length} output(s) with the set-up note before the index, expected exactly 1`);
  } else {
    if (index.length !== 1) fail(`${index.length} notebook index outputs, expected 1`);
    if (ran.some((e) => e.stdout.includes(NOTE))) fail('the set-up note appeared again after the first chat');
  }
  if (ran.length !== 2 || ran.filter((e) => e.stdout === '').length !== 1) fail('expected the index plus one silent twin that exited 0');
} else {
  if (noticeEvents.length !== 1 || noticeLines.length !== 1) {
    fail(`${noticeEvents.length} event(s) hold the notice and ${noticeLines.length} hook(s) printed it as a line, expected exactly one of each`);
  }
  if (noticeLines[0].stdout !== `${notice}\n` && noticeLines[0].stdout !== `${notice}\r\n`) fail('the notice line is not the whole output of its hook');
  if (index.length) fail('the notebook index appeared although Node.js is missing or too old');
  const silent = ran.filter((e) => e.stdout === '').length;
  if (opt.expect === 'nonode' && (ran.length !== 1 || silent !== 0)) fail('with no node the twin of this system should be the only hook that ran, printing the notice');
  if (opt.expect === 'oldnode' && (ran.length !== 2 || silent !== 1)) fail('with Node.js 16 the entry prints the notice and the twin of this system stays silent with exit 0');
}
console.log(`ok: ${opt.expect}`);
