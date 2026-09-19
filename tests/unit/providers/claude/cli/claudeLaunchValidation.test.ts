import type * as fsType from 'fs';
import * as path from 'path';

import { getMissingNodeError } from '@/providers/claude/cli/claudeLaunchValidation';

const fs = jest.requireActual<typeof fsType>('fs');

const isWindows = process.platform === 'win32';

describe('getMissingNodeError', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns null when CLI does not require Node.js', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const error = getMissingNodeError('/path/to/claude');
    expect(error).toBeNull();
  });

  it('returns error when Node.js is missing and CLI requires Node.js', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const error = getMissingNodeError('/path/to/cli.js', '/missing');
    expect(error).toContain('Node.js');
  });

  it('returns null when Node.js is found on PATH', () => {
    const nodeDir = isWindows ? 'C:\\custom\\bin' : '/custom/bin';
    const nodePath = path.join(nodeDir, isWindows ? 'node.exe' : 'node');

    jest.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === nodePath);
    jest.spyOn(fs, 'statSync').mockImplementation(
      p => ({ isFile: () => String(p) === nodePath }) as fsType.Stats
    );

    const error = getMissingNodeError('/path/to/cli.js', nodeDir);
    expect(error).toBeNull();
  });
});
