import { constants } from 'node:buffer';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import * as zlib from 'node:zlib';

import { LineBuffer } from '@/utils/LineBuffer';

const DEFAULT_JSONL_IDLE_TIMEOUT_MS = 10_000;
const JSONL_READ_CHUNK_BYTES = 1024 * 1024;

export interface JSONLFileReadOptions {
  /** Rejects on a line longer than this many UTF-16 code units; defaults to V8's string limit. */
  maxLineLength?: number;
  /** Rejects when the file yields no data for this long; total read time is unbounded. */
  idleTimeoutMs?: number;
  /** Bytes read per chunk; readers that stop early keep this small to avoid reading past the stop. */
  chunkBytes?: number;
}

/** UTF-8 stream of a JSONL file; `.zst` files decompress while streaming, and open failures such as ENOENT still surface. */
function openJSONLStream(filePath: string, highWaterMark: number): Readable {
  if (!filePath.endsWith('.zst')) return createReadStream(filePath, { highWaterMark }).setEncoding('utf8');
  // Older Obsidian installers bundle a Node without zstd support.
  if (typeof zlib.createZstdDecompress !== 'function') {
    throw new Error('Reading compressed history requires a newer Obsidian installer.');
  }
  const raw = createReadStream(filePath, { highWaterMark });
  const decompressed = raw.pipe(zlib.createZstdDecompress());
  raw.once('error', error => decompressed.destroy(error));
  decompressed.once('close', () => raw.destroy());
  return decompressed.setEncoding('utf8');
}

/**
 * Streams a JSONL file one line at a time so files larger than one JavaScript string stay
 * readable. Returning false from `onLine` stops the read. I/O failures, idle timeouts and
 * unreadably long lines reject, so callers never receive history with a silently missing record.
 */
export async function forEachJSONLLine(
  filePath: string,
  onLine: (line: string) => boolean | void,
  options: JSONLFileReadOptions = {},
): Promise<void> {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_JSONL_IDLE_TIMEOUT_MS;
  const lines = new LineBuffer(options.maxLineLength ?? constants.MAX_STRING_LENGTH);
  const input = openJSONLStream(filePath, options.chunkBytes ?? JSONL_READ_CHUNK_BYTES);
  let timer: number | undefined;
  const armTimer = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => input.destroy(new Error('Timed out reading JSONL history.')), idleTimeoutMs);
  };
  const stop = new Error('JSONL read stopped.');
  const accept = (line: string): void => {
    if (onLine(line) === false) throw stop;
  };

  try {
    armTimer();
    for await (const chunk of input as AsyncIterable<string>) {
      armTimer();
      lines.push(chunk, accept);
    }
    if (lines.bufferedLength > 0) accept(lines.take());
  } catch (error) {
    if (error !== stop) throw error;
  } finally {
    window.clearTimeout(timer);
    input.destroy();
  }
}
