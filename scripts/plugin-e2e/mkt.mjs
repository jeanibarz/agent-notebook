// Writes the three marketplace files of the plugin end-to-end test (issue #559).
//
//   node mkt.mjs <dir> <base-url> <marketplace-name> <zip-1> <zip-2>
//
// <dir> must hold the two zips. It gets
//   v1.json   a marketplace whose one plugin entry names zip 1 by URL and sha256
//   v2.json   the same, naming zip 2
//   bad.json  the same as v1.json, with a sha256 that is wrong
// The test copies one of them over mkt.json, the file Claude Code was told to read, to
// "publish" a version. The entry has no `version`: the zip's plugin.json has one, and
// that one decides what an update does.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, base, name, zip1, zip2] = process.argv.slice(2);
if (!zip2) {
  console.error('usage: node mkt.mjs <dir> <base-url> <marketplace-name> <zip-1> <zip-2>');
  process.exit(2);
}
const sha = (zip) => createHash('sha256').update(readFileSync(join(dir, zip))).digest('hex');
const market = (zip, sha256) => ({
  name,
  owner: { name: 'agent-notebook end-to-end test' },
  description: 'A marketplace served by the agent-notebook plugin end-to-end test.',
  plugins: [
    {
      name: 'agent-notebook',
      description: 'Plain-text memory for your AI assistant.',
      source: { source: 'archive', url: `${base}/${zip}`, sha256 },
    },
  ],
});
const write = (file, value) => writeFileSync(join(dir, file), JSON.stringify(value, null, 2) + '\n');
write('v1.json', market(zip1, sha(zip1)));
write('v2.json', market(zip2, sha(zip2)));
write('bad.json', market(zip1, '0'.repeat(64)));
console.log(`marketplace files for ${zip1} and ${zip2} written to ${dir}`);
