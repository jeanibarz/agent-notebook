// genmkt.mjs <dir> <zipfile-name> <entryVersion|none> <baseUrl> [marketplaceName]: write <dir>/marketplace.json naming <dir>/<zip> by sha256.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, zip, ver, base, name = 'nbloop'] = process.argv.slice(2);
const sha = createHash('sha256').update(readFileSync(join(dir, zip))).digest('hex');
const entry = { name: 'agent-notebook', description: 'loopback test', source: { source: 'archive', url: `${base}/${zip}`, sha256: sha } };
if (ver !== 'none') entry.version = ver;
writeFileSync(join(dir, 'marketplace.json'), JSON.stringify({ name, owner: { name: 'agent-notebook' }, plugins: [entry] }, null, 2));
console.log(`marketplace.json -> ${zip} entry-version=${ver} sha=${sha.slice(0, 12)}`);
