// Helpers for reading very large public datasets a piece at a time

import zlib from 'node:zlib';

// Yield a text stream as arrays of whole lines, so millions of lines cost few awaits
export async function* lineBatches(readable) {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of readable) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n');
    rest = lines.pop();
    if (lines.length) yield lines;
  }
  rest += decoder.decode();
  if (rest) yield [rest];
}

// Decompress a gzip download on the fly. A download cut short on purpose (we asked for
// only the first part of a huge file) just ends, instead of failing at the missing tail
export const gunzipStream = (source) => {
  const gunzip = zlib.createGunzip();
  source.on('error', (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  const quiet = async function* () {
    try {
      for await (const chunk of gunzip) yield chunk;
    } catch (error) {
      if (error.code !== 'Z_BUF_ERROR' && !/unexpected end of file/i.test(error.message))
        throw error;
    } finally {
      source.destroy();
      gunzip.destroy();
    }
  };
  return quiet();
};

// Pull the first file out of a zip archive held in memory (enough for one-file downloads)
export const unzipFirst = (archive) => {
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('Not a zip archive');
  const directory = archive.readUInt32LE(end + 16);
  if (archive.readUInt32LE(directory) !== 0x02014b50) throw new Error('Unreadable zip directory');
  const method = archive.readUInt16LE(directory + 10);
  const packed = archive.readUInt32LE(directory + 20);
  const local = archive.readUInt32LE(directory + 42);
  const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
  const body = archive.subarray(start, start + packed);
  if (method === 0) return body;
  if (method === 8) return zlib.inflateRawSync(body);
  throw new Error(`Unsupported zip compression method ${method}`);
};
