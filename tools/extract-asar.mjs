// Extract files from an Electron asar archive (unpack only, no integrity check).
// Usage: node extract-asar.mjs <asar> <outdir> <filter-substring...>
import fs from 'node:fs';
import path from 'node:path';

const [asarPath, outDir, ...filters] = process.argv.slice(2);
if (!asarPath || !outDir) {
  console.error('usage: node extract-asar.mjs <asar> <outdir> [filters...]');
  process.exit(1);
}

const fd = fs.openSync(asarPath, 'r');
const sizeBuf = Buffer.alloc(16);
fs.readSync(fd, sizeBuf, 0, 16, 0);
// pickle: uint32 payloadSize, then header pickle: uint32 headerSize x3
const headerPickleSize = sizeBuf.readUInt32LE(4); // bytes after this offset in first pickle
// Actually layout: [4 bytes header pickle size][header pickle: 4 bytes size, 4 bytes size, 4 bytes json len, json...]
const headerSize = sizeBuf.readUInt32LE(12); // json string length
const headerStart = 16;
const jsonBuf = Buffer.alloc(headerSize);
fs.readSync(fd, jsonBuf, 0, headerSize, headerStart);
const header = JSON.parse(jsonBuf.toString('utf8'));

const baseOffset = 8 + headerPickleSize; // data section start

function walk(node, rel, out) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walk(child, rel ? rel + '/' + name : name, out);
    }
    return;
  }
  if (node.offset === undefined) return; // link or other
  out.push({ rel, offset: Number(node.offset), size: node.size });
}

const files = [];
walk(header, '', files);
const wanted = files.filter((f) => {
  if (filters.length === 0) return true;
  return filters.some((s) => f.rel.includes(s));
});
console.log(`total files in archive: ${files.length}, matching: ${wanted.length}`);

let extracted = 0;
for (const f of wanted) {
  const dest = path.join(outDir, f.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = Buffer.alloc(f.size);
  fs.readSync(fd, buf, 0, f.size, baseOffset + f.offset);
  fs.writeFileSync(dest, buf);
  extracted++;
}
console.log(`extracted: ${extracted} files to ${outDir}`);
