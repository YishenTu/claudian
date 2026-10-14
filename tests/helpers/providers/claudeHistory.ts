import type * as fsType from 'node:fs';
import type * as osType from 'node:os';
import type * as pathType from 'node:path';

const fs = jest.requireActual<typeof fsType>('node:fs');
const os = jest.requireActual<typeof osType>('node:os');
const path = jest.requireActual<typeof pathType>('node:path');

/**
 * Registers a temporary directory for native Claude transcripts, removed after each test.
 * Returns a writer that stores JSONL records (or raw content) and returns the real file path.
 */
export function useClaudeSessionFiles(): (records: readonly unknown[] | string, name?: string) => string {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });
  return (records, name = 'session.jsonl') => {
    directory ??= fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-claude-history-'));
    const filePath = path.join(directory, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, typeof records === 'string'
      ? records
      : records.map(record => JSON.stringify(record)).join('\n'));
    return filePath;
  };
}
