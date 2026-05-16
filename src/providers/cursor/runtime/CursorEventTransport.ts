import * as readline from 'readline';
import type { Readable } from 'stream';

import type { CursorStreamEvent } from './cursorEventTypes';

export type CursorEventListener = (event: CursorStreamEvent) => void;
export type CursorParseErrorListener = (line: string, error: Error) => void;

/**
 * Reads NDJSON events from a `cursor-agent` stdout stream. One JSON object
 * per line; non-JSON lines are routed to the parse-error listener if set.
 */
export class CursorEventTransport {
  private rl: readline.Interface | null = null;
  private listeners = new Set<CursorEventListener>();
  private parseErrorListener: CursorParseErrorListener | null = null;
  private closed = false;
  private closeListeners = new Set<() => void>();

  constructor(private readonly stdout: Readable) {}

  start(): void {
    if (this.rl) {
      return;
    }

    this.rl = readline.createInterface({
      input: this.stdout,
      crlfDelay: Infinity,
    });

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      try {
        const event = JSON.parse(trimmed) as CursorStreamEvent;
        for (const listener of this.listeners) {
          listener(event);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.parseErrorListener?.(trimmed, err);
      }
    });

    this.rl.on('close', () => {
      this.closed = true;
      for (const listener of this.closeListeners) {
        listener();
      }
    });
  }

  onEvent(listener: CursorEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onParseError(listener: CursorParseErrorListener | null): void {
    this.parseErrorListener = listener;
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    if (this.closed) {
      listener();
    }
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  dispose(): void {
    this.rl?.removeAllListeners();
    this.rl?.close();
    this.rl = null;
    this.listeners.clear();
    this.closeListeners.clear();
    this.parseErrorListener = null;
  }
}
