<<<<<<< HEAD
// Test-side ZIP reader: the production reader, made synchronous-looking for the harness.
import zlib from 'node:zlib';

/** Independent synchronous implementation (kept separate from backend/lib/unzip.js on purpose). */
=======
// Tiny independent ZIP reader for tests (reads the central directory, verifies CRC-32).
import zlib from 'node:zlib';

>>>>>>> e209939a43ebc017b0653da4e4fb04b9ff9c165b
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
