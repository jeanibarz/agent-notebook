// Minimal STORE-only zip writer (node:* only). Entries: [{name, data:Buffer, mode}] sorted by UTF-8 bytes; fixed DOS time 1980-01-01.
const T = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
export function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function zip(entries) {
  const es = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')));
  const parts = [], cen = []; let off = 0;
  for (const e of es) {
    const name = Buffer.from(e.name, 'utf8'), crc = crc32(e.data), size = e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(10, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(10, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(((e.mode << 16) >>> 0), 38); ch.writeUInt32LE(off, 42);
    cen.push(ch, name);
    off += 30 + name.length + size;
  }
  const cd = Buffer.concat(cen), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(es.length, 8); end.writeUInt16LE(es.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
