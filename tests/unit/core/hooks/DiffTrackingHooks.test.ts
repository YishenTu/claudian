import * as fs from 'fs';
import * as os from 'os';

import { createFileHashPostHook, createFileHashPreHook } from '@/core/hooks/DiffTrackingHooks';

describe('DiffTrackingHooks path normalization', () => {
  const vaultPath = '/vault';
  let existsSpy: jest.SpyInstance;
  let statSpy: jest.SpyInstance;
  let readSpy: jest.SpyInstance;

  beforeEach(() => {
    existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    statSpy = jest.spyOn(fs, 'statSync').mockReturnValue({ size: 10 } as any);
    readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue('original');
  });

  afterEach(() => {
    existsSpy.mockRestore();
    statSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('expands home paths before checking filesystem in pre-hook', async () => {
    const homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
    const originalContents = new Map();
    const hook = createFileHashPreHook(vaultPath, originalContents);

    await hook.hooks[0](
      {
        tool_name: 'Write',
        tool_input: { file_path: '~/notes/a.md' },
      },
      'tool-1'
    );

    expect(existsSpy).toHaveBeenCalledWith('/home/test/notes/a.md');
    homedirSpy.mockRestore();
  });

  it('expands environment variables before reading filesystem in post-hook', async () => {
    const envKey = 'CLAUDIAN_DIFF_TEST_PATH';
    const originalValue = process.env[envKey];
    process.env[envKey] = '/tmp/claudian';

    readSpy.mockReturnValue('new');

    const originalContents = new Map();
    originalContents.set('tool-2', { filePath: `$${envKey}/notes/a.md`, content: 'old' });
    const pendingDiffData = new Map();
    const hook = createFileHashPostHook(vaultPath, originalContents, pendingDiffData);

    await hook.hooks[0](
      {
        tool_name: 'Write',
        tool_input: { file_path: `$${envKey}/notes/a.md` },
        tool_result: { is_error: false },
      },
      'tool-2'
    );

    expect(existsSpy).toHaveBeenCalledWith('/tmp/claudian/notes/a.md');
    expect(pendingDiffData.get('tool-2')).toEqual({
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
