import { constants } from 'node:buffer';
import { createReadStream } from 'node:fs';

import { LineBuffer } from '@/utils/LineBuffer';

const DEFAULT_JSONL_IDLE_TIMEOUT_MS = 10_000;
const JSONL_READ_CHUNK_BYTES = 1024 * 1024;

export interface JSONLFileReadOptions {
  /** Rejects on a line longer than this many UTF-16 code units; defaults to V8's string limit. */
  maxLineLength?: number;
  /** Rejects when the file yields no data for this long; total read time is unbounded. */
  idleTimeoutMs?: number;
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
  const input = createReadStream(filePath, { encoding: 'utf8', highWaterMark: JSONL_READ_CHUNK_BYTES });
  let timer: number | undefined;
  const armTimer = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => input.destroy(new Error('Timed out reading JSONL history.')), idleTimeoutMs);
  };
  let stopped = false;
  const accept = (line: string): void => {
    if (!stopped && onLine(line) === false) stopped = true;
  };

  try {
    armTimer();
    for await (const chunk of input as AsyncIterable<string>) {
      armTimer();
      lines.push(chunk, accept);
      if (stopped) return;
    }
    if (lines.bufferedLength > 0) accept(lines.take());
  } finally {
    window.clearTimeout(timer);
    input.destroy();
  }
}
