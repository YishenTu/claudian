import * as fs from 'fs';
import * as os from 'os';

import {
  clearDiffState,
  createFileHashPostHook,
  createFileHashPreHook,
  getDiffData,
} from '@/core/hooks/DiffTrackingHooks';

describe('DiffTrackingHooks path normalization', () => {
  const vaultPath = '/vault';
  let existsSpy: jest.SpyInstance;
  let statSpy: jest.SpyInstance;
  let readSpy: jest.SpyInstance;

  beforeEach(() => {
    clearDiffState(); // Clear singleton state before each test
    existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    statSpy = jest.spyOn(fs, 'statSync').mockReturnValue({ size: 10 } as any);
    readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue('original');
  });

  afterEach(() => {
    existsSpy.mockRestore();
    statSpy.mockRestore();
    readSpy.mockRestore();
    clearDiffState(); // Clean up after each test
  });

  it('expands home paths before checking filesystem in pre-hook', async () => {
    const homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
    const hook = createFileHashPreHook(vaultPath);

    await hook.hooks[0](
      {
        hook_event_name: 'PreToolUse',
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        cwd: vaultPath,
        tool_name: 'Write',
        tool_input: { file_path: '~/notes/a.md' },
      } as any,
      'tool-1',
      { signal: new AbortController().signal }
    );

    expect(existsSpy).toHaveBeenCalledWith('/home/test/notes/a.md');
    homedirSpy.mockRestore();
  });

  it('expands environment variables before reading filesystem in post-hook', async () => {
    const envKey = 'CLAUDIAN_DIFF_TEST_PATH';
    const originalValue = process.env[envKey];
    process.env[envKey] = '/tmp/claudian';

    // First, call pre-hook to set up original content
    const preHook = createFileHashPreHook(vaultPath);
    readSpy.mockReturnValue('old');

    await preHook.hooks[0](
      {
        hook_event_name: 'PreToolUse',
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        cwd: vaultPath,
        tool_name: 'Write',
        tool_input: { file_path: `$${envKey}/notes/a.md` },
      } as any,
      'tool-2',
      { signal: new AbortController().signal }
    );

    // Now call post-hook with new content
    readSpy.mockReturnValue('new');
    const postHook = createFileHashPostHook(vaultPath);

    await postHook.hooks[0](
      {
        hook_event_name: 'PostToolUse',
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        cwd: vaultPath,
        tool_name: 'Write',
        tool_input: { file_path: `$${envKey}/notes/a.md` },
        tool_result: { is_error: false },
      } as any,
      'tool-2',
      { signal: new AbortController().signal }
    );

    expect(existsSpy).toHaveBeenCalledWith('/tmp/claudian/notes/a.md');

    const diffData = getDiffData('tool-2');
    expect(diffData).toEqual({
      filePath: `$${envKey}/notes/a.md`,
      originalContent: 'old',
      newContent: 'new',
    });

    if (originalValue === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalValue;
    }
  });
});

describe('DiffTrackingHooks file operations', () => {
  const vaultPath = '/test/vault/path';
  let existsSpy: jest.SpyInstance;
  let statSpy: jest.SpyInstance;
  let readSpy: jest.SpyInstance;

  beforeEach(() => {
    clearDiffState();
    existsSpy = jest.spyOn(fs, 'existsSync');
    statSpy = jest.spyOn(fs, 'statSync');
    readSpy = jest.spyOn(fs, 'readFileSync');
  });

  afterEach(() => {
    existsSpy.mockRestore();
    statSpy.mockRestore();
    readSpy.mockRestore();
    clearDiffState();
  });

  it('captures original content and computes diff for small file', async () => {
    existsSpy.mockReturnValue(true);
    statSpy.mockReturnValue({ size: 10 });
    readSpy
      .mockReturnValueOnce('old')
      .mockReturnValueOnce('new');

    const preHook = createFileHashPreHook(vaultPath);
    const postHook = createFileHashPostHook(vaultPath);

    await preHook.hooks[0](
      { tool_name: 'Write', tool_input: { file_path: 'note.md' } } as any,
      'tool-1',
      {} as any
    );
    await postHook.hooks[0](
      { tool_name: 'Write', tool_input: { file_path: 'note.md' }, tool_result: {} } as any,
      'tool-1',
      {} as any
    );

    const diff = getDiffData('tool-1');
    expect(diff).toEqual({ filePath: 'note.md', originalContent: 'old', newContent: 'new' });
  });

  it('skips diff when original file is too large', async () => {
    existsSpy.mockReturnValue(true);
    statSpy.mockReturnValue({ size: 200 * 1024 }); // 200KB, over 100KB limit

    const preHook = createFileHashPreHook(vaultPath);
    const postHook = createFileHashPostHook(vaultPath);

    await preHook.hooks[0](
      { tool_name: 'Edit', tool_input: { file_path: 'big.md' } } as any,
      'tool-big',
      {} as any
    );
    await postHook.hooks[0](
      { tool_name: 'Edit', tool_input: { file_path: 'big.md' }, tool_result: {} } as any,
      'tool-big',
      {} as any
    );

    const diff = getDiffData('tool-big');
    expect(diff).toEqual({ filePath: 'big.md', skippedReason: 'too_large' });
  });

  it('marks diff unavailable when file does not exist', async () => {
    existsSpy.mockReturnValue(false);
    statSpy.mockReturnValue({ size: 10 });

    const preHook = createFileHashPreHook(vaultPath);
    const postHook = createFileHashPostHook(vaultPath);

    await preHook.hooks[0](
      { tool_name: 'Write', tool_input: { file_path: 'new.md' } } as any,
      'tool-new',
      {} as any
    );
    await postHook.hooks[0](
      { tool_name: 'Write', tool_input: { file_path: 'new.md' }, tool_result: {} } as any,
      'tool-new',
      {} as any
    );

    const diff = getDiffData('tool-new');
    expect(diff).toEqual({ filePath: 'new.md', skippedReason: 'unavailable' });
  });

  it('handles Edit tool same as Write tool', async () => {
    existsSpy.mockReturnValue(true);
    statSpy.mockReturnValue({ size: 50 });
    readSpy
      .mockReturnValueOnce('original text')
      .mockReturnValueOnce('modified text');

    const preHook = createFileHashPreHook(vaultPath);
    const postHook = createFileHashPostHook(vaultPath);

    await preHook.hooks[0](
      { tool_name: 'Edit', tool_input: { file_path: 'edit.md' } } as any,
      'tool-edit',
      {} as any
    );
    await postHook.hooks[0](
      { tool_name: 'Edit', tool_input: { file_path: 'edit.md' }, tool_result: {} } as any,
      'tool-edit',
      {} as any
    );

    const diff = getDiffData('tool-edit');
    expect(diff).toEqual({
      filePath: 'edit.md',
      originalContent: 'original text',
      newContent: 'modified text',
    });
  });

  it('ignores non-Write/Edit tools', async () => {
    const preHook = createFileHashPreHook(vaultPath);
    const postHook = createFileHashPostHook(vaultPath);

    await preHook.hooks[0](
      { tool_name: 'Read', tool_input: { file_path: 'read.md' } } as any,
      'tool-read',
      {} as any
    );
    await postHook.hooks[0](
      { tool_name: 'Read', tool_input: { file_path: 'read.md' }, tool_result: {} } as any,
      'tool-read',
      {} as any
    );

    const diff = getDiffData('tool-read');
    expect(diff).toBeUndefined();
  });

  it('clearDiffState removes all diff data', async () => {
    existsSpy.mockReturnValue(true);
    statSpy.mockReturnValue({ size: 10 });
    readSpy.mockReturnValue('content');

    const preHook = createFileHashPreHook(vaultPath);
    const postHook = createFileHashPostHook(vaultPath);

    await preHook.hooks[0](
      { tool_name: 'Write', tool_input: { file_path: 'a.md' } } as any,
      'tool-a',
      {} as any
    );
    await postHook.hooks[0](
      { tool_name: 'Write', tool_input: { file_path: 'a.md' }, tool_result: {} } as any,
      'tool-a',
      {} as any
    );

    expect(getDiffData('tool-a')).toBeDefined();

    clearDiffState();

    expect(getDiffData('tool-a')).toBeUndefined();
  });

  it('getDiffData removes data after retrieval (consume-once)', async () => {
    existsSpy.mockReturnValue(true);
    statSpy.mockReturnValue({ size: 10 });
    readSpy.mockReturnValueOnce('old').mockReturnValueOnce('new');

    const preHook = createFileHashPreHook(vaultPath);
    const postHook = createFileHashPostHook(vaultPath);

    await preHook.hooks[0](
      { tool_name: 'Write', tool_input: { file_path: 'consume.md' } } as any,
      'tool-consume',
      {} as any
    );
    await postHook.hooks[0](
      { tool_name: 'Write', tool_input: { file_path: 'consume.md' }, tool_result: {} } as any,
      'tool-consume',
      {} as any
    );

    // First get should return the data
    const firstGet = getDiffData('tool-consume');
    expect(firstGet).toBeDefined();
    expect(firstGet?.originalContent).toBe('old');
    expect(firstGet?.newContent).toBe('new');

    // Second get should return undefined (consumed)
    const secondGet = getDiffData('tool-consume');
    expect(secondGet).toBeUndefined();
  });

  it('ignores NotebookEdit for diff capture (matches but skips)', async () => {
    existsSpy.mockReturnValue(true);
    statSpy.mockReturnValue({ size: 10 });
    readSpy.mockReturnValue('content');

    const preHook = createFileHashPreHook(vaultPath);
    const postHook = createFileHashPostHook(vaultPath);

    // NotebookEdit should match the hook but not capture diff
    await preHook.hooks[0](
      { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'notebook.ipynb' } } as any,
      'tool-notebook',
      {} as any
    );
    await postHook.hooks[0](
      { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'notebook.ipynb' }, tool_result: {} } as any,
      'tool-notebook',
      {} as any
    );

    // NotebookEdit is explicitly excluded from diff capture
    const diff = getDiffData('tool-notebook');
    expect(diff).toBeUndefined();
  });
});

describe('DiffTrackingHooks public API', () => {
  beforeEach(() => {
    clearDiffState();
  });

  afterEach(() => {
    clearDiffState();
  });

  describe('getDiffData', () => {
    it('returns undefined for non-existent toolUseId', () => {
      const result = getDiffData('non-existent-tool-id');
      expect(result).toBeUndefined();
    });

    it('returns undefined for empty string toolUseId', () => {
      const result = getDiffData('');
      expect(result).toBeUndefined();
    });
  });

  describe('clearDiffState', () => {
    it('is idempotent - can be called multiple times safely', () => {
      // Call clear multiple times on empty store
      expect(() => {
        clearDiffState();
        clearDiffState();
        clearDiffState();
      }).not.toThrow();
    });

    it('clears state after being called once', async () => {
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const statSpy = jest.spyOn(fs, 'statSync').mockReturnValue({ size: 10 } as any);
      const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue('content');

      const preHook = createFileHashPreHook('/vault');
      const postHook = createFileHashPostHook('/vault');

      // Add some data
      await preHook.hooks[0](
        { tool_name: 'Write', tool_input: { file_path: 'test.md' } } as any,
        'tool-clear-test',
        {} as any
      );
      await postHook.hooks[0](
        { tool_name: 'Write', tool_input: { file_path: 'test.md' }, tool_result: {} } as any,
        'tool-clear-test',
        {} as any
      );

      // Clear and verify
      clearDiffState();
      expect(getDiffData('tool-clear-test')).toBeUndefined();

      // Clear again should still work
      clearDiffState();
      expect(getDiffData('tool-clear-test')).toBeUndefined();

      existsSpy.mockRestore();
      statSpy.mockRestore();
      readSpy.mockRestore();
    });
  });
});
