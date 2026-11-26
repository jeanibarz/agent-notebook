// hookrep.mjs <stream.jsonl>: print one line per hook_response, node only (so it runs on every OS).
import { readFileSync } from 'node:fs';
const clip = (s) => String(s ?? '').slice(0, 110).replace(/\r?\n/g, '\\n');
for (const line of readFileSync(process.argv[2], 'utf-8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  if (!line.trim()) continue;
  let e; try { e = JSON.parse(line); } catch { console.log('RAW', clip(line)); continue; }
  if (e.subtype === 'init') console.log('INIT skills:', JSON.stringify((e.skills || []).filter((x) => /notebook/.test(x))), 'of', (e.skills || []).length, '| slash_commands matching:', JSON.stringify((e.slash_commands || []).filter((x) => /notebook/.test(x))), '| plugins:', JSON.stringify((e.plugins || []).filter((x) => /notebook/.test(JSON.stringify(x)))));
  if (e.subtype === 'hook_response') if (e.exit_code && e.stderr) console.log('  FULL STDERR:', String(e.stderr).slice(0, 400).replace(/\r?\n/g, ' '));
  if (e.subtype === 'hook_response') console.log('HOOK', e.hook_name, 'exit', e.exit_code, e.outcome, '| stdout:', clip(e.stdout).slice(0, 80), '| stderr:', clip(e.stderr));
}
