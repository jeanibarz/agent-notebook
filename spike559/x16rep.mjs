// x16rep.mjs <stream.jsonl>: classify each SessionStart hook_response (notice byte-equality, planted markers, errors).
import { readFileSync } from 'node:fs';
const NOTICE = 'agent-notebook: the notebook needs Node.js 18 or later, which this computer does not have yet. Tell the user, in plain words: Node.js is a free program, download the LTS version from https://nodejs.org and install it, then quit Claude Code completely, with Cmd+Q on a Mac or by closing every terminal window on Windows, and open it again. Until then the notebook is off.';
let n = 0, notices = 0, errors = 0, planted = 0;
for (const line of readFileSync(process.argv[2], 'utf-8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  if (!line.trim()) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (e.subtype !== 'hook_response') continue;
  n++; const o = String(e.stdout ?? ''), er = String(e.stderr ?? '');
  let kind;
  if (/PLANTED/.test(o + er)) { kind = 'PLANTED RAN: ' + JSON.stringify(o.slice(0, 80)); planted++; }
  else if (o === NOTICE + '\n') { kind = 'NOTICE byte-equal (LF-terminated)'; notices++; }
  else if (o === NOTICE + '\r\n') { kind = 'NOTICE byte-equal (CRLF-terminated)'; notices++; }
  else if (o.startsWith('agent-notebook: the notebook needs')) { kind = 'NOTICE DIFFERS: length ' + o.length + ' vs ' + (NOTICE.length + 1) + ', tail hex ' + Buffer.from(o.slice(-6)).toString('hex'); notices++; }
  else if (o.startsWith('## Your agent-notebook index')) kind = 'index';
  else if (o === '') kind = 'empty';
  else kind = 'OTHER: ' + JSON.stringify(o.slice(0, 80));
  if (e.outcome === 'error' || e.exit_code) errors++;
  console.log('  HOOK exit', e.exit_code, e.outcome, '|', kind, er ? '| stderr: ' + JSON.stringify(er.slice(0, 120)) : '');
}
console.log(`  SUMMARY hooks=${n} notices=${notices} errors=${errors} planted_ran=${planted}`);
