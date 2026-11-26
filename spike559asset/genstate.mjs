// node genstate.mjs <1|2|3|4> : writes spike559asset/raw/marketplace.json (and other.json) for a state.
// states 1 and 3 name the old zip (served by raw), 2 and 4 name the real release asset.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const raw = join(dirname(fileURLToPath(import.meta.url)), 'raw');
const n = Number(process.argv[2]);
const OLD = { url: 'https://raw.githubusercontent.com/jeanibarz/agent-notebook/refs/heads/spike/559-asset/spike559asset/raw/old/agent-notebook-plugin-0.13.0-beta.1.559.zip', sha256: '9656893df022425b5837f2104de988b98132d9f983a5e50689702745980a2ddf' };
const NEW = { url: 'https://github.com/jeanibarz/agent-notebook/releases/download/v0.13.0-beta.2/agent-notebook-plugin-0.13.0-beta.2.zip', sha256: '68b64348e8b7d8cd32bd4b8f9831fc5c0089ef385ec63d71003d07ce1627c5cf' };
const src = n % 2 === 1 ? OLD : NEW;
const mk = (name) => ({ name, owner: { name: 'spike 559' }, description: `spike559asset marketplace, state=${n}`, plugins: [{ name: 'agent-notebook', description: 'Plain-text memory for your AI assistant.', source: { source: 'archive', ...src } }] });
writeFileSync(join(raw, 'marketplace.json'), JSON.stringify(mk('agent-notebook'), null, 2) + '\n');
writeFileSync(join(raw, 'other.json'), JSON.stringify(mk('nb559other'), null, 2) + '\n');
console.log(`state ${n}`);
