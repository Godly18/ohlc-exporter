// Minimal ZIP reader for archives that hold ONE file (Binance monthly kline archives). Reads the central
// directory, supports stored/deflate, and verifies size and CRC-32. Uses only node:zlib.

import { promisify } from 'node:util';
import zlib from 'node:zlib';

const inflateRaw = promisify(zlib.inflateRaw);
const MAX_UNCOMPRESSED = 400 * 1024 * 1024; // refuse zip bombs

export async function unzipSingle(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || buf.length < eocd + 22) throw new Error('not a zip file');
  const entries = buf.readUInt16LE(eocd + 10);
  if (entries !== 1) throw new Error(`expected exactly one file in the archive, found ${entries}`);
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('bad central directory');
  const method = buf.readUInt16LE(cd + 10);
  const crc = buf.readUInt32LE(cd + 16);
  const csize = buf.readUInt32LE(cd + 20);
  const usize = buf.readUInt32LE(cd + 24);
  const nameLen = buf.readUInt16LE(cd + 28);
  const name = buf.subarray(cd + 46, cd + 46 + nameLen).toString('utf8');
  const lho = buf.readUInt32LE(cd + 42);
  if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('bad local header');
  if (usize > MAX_UNCOMPRESSED) throw new Error('archive too large');
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const raw = buf.subarray(start, start + csize);
  let data;
  if (method === 8) data = await inflateRaw(raw);
  else if (method === 0) data = raw;
  else throw new Error(`unsupported compression method ${method}`);
  if (data.length !== usize) throw new Error('size mismatch');
  if (zlib.crc32(data) !== crc) throw new Error('crc mismatch');
  return { name, data };
}
