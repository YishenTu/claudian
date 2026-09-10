import type { Writable } from 'node:stream';

export type PiJsonlLineHandler = (line: string) => void;

interface JsonlReadableStream {
  off(eventName: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(eventName: 'end' | 'close', listener: () => void): unknown;
  off(eventName: 'error', listener: (error: unknown) => void): unknown;
  on(eventName: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(eventName: 'end' | 'close', listener: () => void): unknown;
  on(eventName: 'error', listener: (error: unknown) => void): unknown;
}

export function subscribePiJsonlLines(
  input: JsonlReadableStream,
  onLine: PiJsonlLineHandler,
  onEnd?: () => void,
  onError?: (error: Error) => void,
): () => void {
  let buffer = '';

  const handleData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) {
        break;
      }

      const line = stripTrailingCarriageReturn(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      onLine(line);
    }
  };

  const handleEnd = (): void => {
    if (buffer.length > 0) {
      onLine(stripTrailingCarriageReturn(buffer));
      buffer = '';
    }
    onEnd?.();
  };

  const handleError = (error: unknown): void => {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  };

  input.on('data', handleData);
  input.on('end', handleEnd);
  input.on('close', handleEnd);
  input.on('error', handleError);

  return () => {
    input.off('data', handleData);
    input.off('end', handleEnd);
    input.off('close', handleEnd);
    input.off('error', handleError);
  };
}

export function writePiJsonl(
  output: Writable | NodeJS.WritableStream,
  record: unknown,
): void {
  output.write(`${JSON.stringify(record)}\n`);
}

function stripTrailingCarriageReturn(value: string): string {
  return value.endsWith('\r') ? value.slice(0, -1) : value;
}
