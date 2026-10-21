// Test-side ZIP reader: the production reader, made synchronous-looking for the harness.
import zlib from 'node:zlib';

/** Independent synchronous implementation (kept separate from backend/lib/unzip.js on purpose). */
export function unzipSingle(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end-of-central-directory');
  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('bad central directory');
  const method = buf.readUInt16LE(cdOffset + 10);
  const crc = buf.readUInt32LE(cdOffset + 16);
  const csize = buf.readUInt32LE(cdOffset + 20);
  const usize = buf.readUInt32LE(cdOffset + 24);
  const nameLen = buf.readUInt16LE(cdOffset + 28);
  const name = buf.subarray(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf8');
  const lho = buf.readUInt32LE(cdOffset + 42);
  if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('bad local header');
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  if (method !== 8) throw new Error('not deflate');
  const data = zlib.inflateRawSync(buf.subarray(start, start + csize));
  if (data.length !== usize) throw new Error('size mismatch');
  if (zlib.crc32(data) !== crc) throw new Error('crc mismatch');
  return { entries, name, data };
}

/** All entries of an archive (independent reader): [{ name, data }]. */
export function unzipAll(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end-of-central-directory');
  const count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('bad central directory');
    const crc = buf.readUInt32LE(cd + 16);
    const csize = buf.readUInt32LE(cd + 20);
    const usize = buf.readUInt32LE(cd + 24);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const name = buf.subarray(cd + 46, cd + 46 + nameLen).toString('utf8');
    const lho = buf.readUInt32LE(cd + 42);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = zlib.inflateRawSync(buf.subarray(start, start + csize));
    if (data.length !== usize || zlib.crc32(data) !== crc) throw new Error(`entry ${name} is corrupt`);
    out.push({ name, data });
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
