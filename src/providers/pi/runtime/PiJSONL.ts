import type { Writable } from 'node:stream';

export function writePiJSONL(
  output: Writable | NodeJS.WritableStream,
  record: unknown,
): void {
  output.write(`${JSON.stringify(record)}\n`);
}
