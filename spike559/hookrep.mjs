// hookrep.mjs <stream.jsonl>: print one line per hook_response, node only (so it runs on every OS).
import { readFileSync } from 'node:fs';
const clip = (s) => String(s ?? '').slice(0, 110).replace(/\r?\n/g, '\\n');
for (const line of readFileSync(process.argv[2], 'utf-8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  let e; try { e = JSON.parse(line); } catch { console.log('RAW', clip(line)); continue; }
  if (e.subtype === 'hook_response') console.log('HOOK', e.hook_name, 'exit', e.exit_code, e.outcome, '| stdout:', clip(e.stdout), '| stderr:', clip(e.stderr));
}
