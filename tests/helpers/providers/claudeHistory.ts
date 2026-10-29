const actualModule0 = await vi.importActual<typeof import('node:fs')>('node:fs');
const actualModule1 = await vi.importActual<typeof import('node:os')>('node:os');
const actualModule2 = await vi.importActual<typeof import('node:path')>('node:path');


const fs = actualModule0;
const os = actualModule1;
const path = actualModule2;

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
