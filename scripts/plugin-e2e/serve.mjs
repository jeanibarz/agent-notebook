// A static HTTPS server for the plugin end-to-end test (issue #559).
//
//   node serve.mjs --print-ip
//   node serve.mjs <dir> <ip> <port> <cert.pem> <key.pem> <ready-file>
//
// A <port> of 0 lets the system pick a free one; <ready-file> then names it, as host:port.
// --print-ip prints the computer's own non-loopback IPv4 address. Claude Code refuses an
// archive on http:// and on a loopback or link-local address, so the test serves its
// marketplace over https on the address the runner has on its network, with a
// self-signed certificate that names this address and is handed to Claude Code in
// NODE_EXTRA_CA_CERTS. The server writes <ready-file> once it listens, and logs every
// request. It serves files of <dir> by their base name only, and nothing else.
import { createServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

if (process.argv[2] === '--print-ip') {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        console.log(a.address);
        process.exit(0);
      }
    }
  }
  console.error('serve: this computer has no non-loopback IPv4 address');
  process.exit(1);
}

const [dir, host, port, certFile, keyFile, readyFile] = process.argv.slice(2);
if (!readyFile) {
  console.error('usage: node serve.mjs <dir> <ip> <port> <cert.pem> <key.pem> <ready-file>');
  process.exit(2);
}
const server = createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, (req, res) => {
  const name = basename(decodeURIComponent((req.url ?? '').split('?')[0]));
  const file = join(dir, name);
  const found = name !== '' && existsSync(file) && statSync(file).isFile();
  console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${found ? 200 : 404}`);
  if (!found) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  res.setHeader('content-type', name.endsWith('.json') ? 'application/json' : 'application/zip');
  res.end(readFileSync(file));
});
server.listen(Number(port), host, () => {
  const actual = server.address().port;
  console.log(`listening https://${host}:${actual}`);
  writeFileSync(readyFile, `${host}:${actual}\n`);
});
