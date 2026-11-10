const actualModule0 = await import('fs');
const actualModule1 = await import('os');
const actualModule2 = await import('path');
const actualModule3 = await import('zlib');

const fs = actualModule0;
const os = actualModule1;
const path = actualModule2;
const { zstdCompressSync } = actualModule3;

import { forEachJSONLLine } from '@/utils/jsonlFile';


describe('forEachJSONLLine', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-jsonl-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(content: string | Buffer): string {
    const file = path.join(dir, 'history.jsonl');
    fs.writeFileSync(file, content);
    return file;
  }

  async function collect(file: string, maxLineLength?: number): Promise<string[]> {
    const lines: string[] = [];
    await forEachJSONLLine(file, line => { lines.push(line); }, { maxLineLength });
    return lines;
  }

  it('reassembles lines and multibyte characters split across read chunks', async () => {
    // The reader uses 1 MiB chunks; place a 4-byte character across the boundary.
    const first = `${'a'.repeat(1024 * 1024 - 2)}😀b`;
    const file = write(`${first}\r\n{"x":1}\nlast`);

    await expect(collect(file)).resolves.toEqual([first, '{"x":1}', 'last']);
  });

  it('rejects instead of skipping a line longer than the limit', async () => {
    // Skipping would hand consumers a history with a silently missing record.
    const file = write('0\n123456789\n1\n');
    const lines: string[] = [];

    await expect(forEachJSONLLine(file, line => { lines.push(line); }, { maxLineLength: 4 }))
      .rejects.toThrow(new Error('Line exceeded the size limit.'));
    expect(lines).toEqual(['0']);
  });

  it('streams Zstandard-compressed files and surfaces their open and decode failures', async () => {
    const compressed = path.join(dir, 'history.jsonl.zst');
    fs.writeFileSync(compressed, zstdCompressSync('{"x":1}\nlast'));
    await expect(collect(compressed)).resolves.toEqual(['{"x":1}', 'last']);

    // Codex history maps ENOENT to a missing transcript, so it must not become a decode error or timeout.
    await expect(collect(path.join(dir, 'missing.jsonl.zst'))).rejects.toMatchObject({ code: 'ENOENT' });

    fs.writeFileSync(compressed, '{"x":1}\n');
    await expect(collect(compressed)).rejects.toMatchObject({ code: 'ZSTD_error_prefix_unknown' });
  });

  it('rejects compressed files cleanly when the host lacks Zstandard support', async () => {
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);
    try {
      vi.resetModules();
      vi.doMock('node:zlib', async () => ({ ...await vi.importActual<typeof import('node:zlib')>('node:zlib'), createZstdDecompress: undefined }));
      const { forEachJSONLLine: readWithoutZstd } = await import('@/utils/jsonlFile');
      await expect(readWithoutZstd(path.join(dir, 'missing.jsonl.zst'), () => {}))
        .rejects.toThrow('Reading compressed history requires a newer Obsidian installer.');
      // A file opened before the capability check would report ENOENT after the rejection.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', uncaught);
      vi.doUnmock('node:zlib');
      vi.resetModules();
    }
  });

  it('stops when the handler returns false', async () => {
    const file = write('a\nb\nc\n');
    const lines: string[] = [];

    await forEachJSONLLine(file, line => { lines.push(line); return line !== 'b'; });

    expect(lines).toEqual(['a', 'b']);
  });

  it('stops when the handler returns false on an unterminated final line', async () => {
    const file = write('0');
    const lines: string[] = [];

    await forEachJSONLLine(file, line => { lines.push(line); return false; });

    expect(lines).toEqual(['0']);
  });

  it.each(['0\n', '0'])('rejects with the error the consumer threw for %j', async content => {
    const file = write(content);
    const failure = new Error('consumer failed');
    const lines: string[] = [];

    await expect(forEachJSONLLine(file, line => { lines.push(line); throw failure; })).rejects.toBe(failure);
    expect(lines).toEqual(['0']);
  });

  it('stops before an unread oversized line', async () => {
    const file = write('0\n123456789\n1\n');
    const lines: string[] = [];

    await forEachJSONLLine(file, line => { lines.push(line); return false; }, { maxLineLength: 4 });

    expect(lines).toEqual(['0']);
  });

  it('rejects when the file cannot be read', async () => {
    await expect(collect(path.join(dir, 'missing.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
