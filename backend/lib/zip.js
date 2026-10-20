// Minimal streaming ZIP writer for ONE file (the CSV), using only node:zlib. No dependencies.
//
// Layout: local header (sizes/CRC deferred via a data descriptor) + deflate stream + data descriptor +
// central directory + end-of-central-directory. Because nothing needs to be known up front, the CSV is
// compressed while it is generated and never held in memory as a whole. Standard ZIP (not ZIP64), so a
// single entry must stay below 4 GiB; the export size limits keep real exports far below that.
// Opens with Windows Explorer, macOS Archive Utility, 7-Zip, unzip, etc.

import { once } from 'node:events';
import zlib from 'node:zlib';

const MAX_32 = 0xffff_ffff;
const FLAGS = 0x0808; // bit 3: sizes in data descriptor; bit 11: UTF-8 file name
const VERSION = 20;

function dosDateTime(ms) {
  const d = new Date(ms);
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

/**
 * @param {string} entryName  file name inside the archive, e.g. EUR_USD_M1_2026-09-01_2026-09-13.csv
 * @param {AsyncIterable<Buffer>} source  the file's bytes
 * @param {number} mtimeMs    modification time stored on the entry (UTC)
 * @returns {AsyncGenerator<Buffer>} the ZIP archive bytes
 */
export async function* zipSingleFile(entryName, source, mtimeMs) {
  const name = Buffer.from(entryName, 'utf8');
  const { time, date } = dosDateTime(mtimeMs);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(VERSION, 4);
  local.writeUInt16LE(FLAGS, 6);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  // crc32, compressed size, uncompressed size = 0 (in data descriptor)
  local.writeUInt16LE(name.length, 26);
  yield Buffer.concat([local, name]);
  let offset = local.length + name.length;

  const deflate = zlib.createDeflateRaw({ level: 6 });
  const stop = new AbortController();
  let crc = 0;
  let usize = 0;
  let csize = 0;

  const feeder = (async () => {
    try {
      for await (const chunk of source) {
        crc = zlib.crc32(chunk, crc);
        usize += chunk.length;
        if (!deflate.write(chunk)) await once(deflate, 'drain', { signal: stop.signal });
      }
      deflate.end();
    } catch (err) {
      deflate.destroy(err);
    }
  })();

  try {
    for await (const out of deflate) {
      csize += out.length;
      offset += out.length;
      yield out;
    }
  } finally {
    stop.abort(); // consumer gave up or an error occurred: release the feeder
    deflate.destroy();
    await feeder.catch(() => {});
  }

  if (usize > MAX_32 || csize > MAX_32) throw new Error('export too large for a standard ZIP file');
  crc >>>= 0;

  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(csize, 8);
  descriptor.writeUInt32LE(usize, 12);
  yield descriptor;
  offset += descriptor.length;

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | VERSION, 4); // made by: Unix, 2.0
  central.writeUInt16LE(VERSION, 6);
  central.writeUInt16LE(FLAGS, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(csize, 20);
  central.writeUInt32LE(usize, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // regular file, rw-r--r--
  central.writeUInt32LE(0, 42); // local header offset
  const centralSize = central.length + name.length;
  yield Buffer.concat([central, name]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  yield end;
}
