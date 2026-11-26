// Tiny static server for the loopback marketplace. Usage: node serve.mjs <dir> <port>
import { createServer as http } from 'node:http';
import { createServer as https } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
const [dir, port] = [process.argv[2], Number(process.argv[3])];
const handler = (req, res) => {
  const f = join(dir, basename(req.url.split('?')[0]));
  console.log(new Date().toISOString(), req.method, req.url, existsSync(f) ? 200 : 404);
  if (!existsSync(f)) { res.statusCode = 404; res.end('nope'); return; }
  res.setHeader('content-type', f.endsWith('.json') ? 'application/json' : 'application/zip');
  res.end(readFileSync(f));
};
// Usage: node serve.mjs <dir> <port> [<bindhost> <cert.pem> <key.pem>]  (cert+key => https)
const host = process.argv[4] || '127.0.0.1';
const srv = process.argv[5] ? https({ cert: readFileSync(process.argv[5]), key: readFileSync(process.argv[6]) }, handler) : http(handler);
srv.listen(port, host, () => console.log('listening', host, port));
