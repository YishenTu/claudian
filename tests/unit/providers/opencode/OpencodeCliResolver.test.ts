import * as fs from 'fs';
import * as path from 'path';

import { OpencodeCliResolver } from '@/providers/opencode/runtime/OpencodeCliResolver';

jest.mock('fs');
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
}));

const mockedStat = fs.statSync as jest.Mock;

describe('OpencodeCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  it('uses the current host path instead of another synced host path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/current/opencode') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new OpencodeCliResolver();
    const resolved = resolver.resolve(
      {
        'other-host': '/other/opencode',
        'current-host': '/current/opencode',
      },
      '/legacy/opencode',
      '',
    );

    expect(resolved).toBe('/current/opencode');
  });

  it('falls back to the legacy path when the current host has no custom path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/legacy/opencode') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new OpencodeCliResolver();
    const resolved = resolver.resolve(
      {
        'other-host': '/other/opencode',
      },
      '/legacy/opencode',
      '',
    );

    expect(resolved).toBe('/legacy/opencode');
  });

  it('returns null when neither the current host nor the legacy path resolve to a file', () => {
    mockedStat.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const resolver = new OpencodeCliResolver();
    const resolved = resolver.resolve(
      {
        'other-host': '/other/opencode',
      },
      '/legacy/opencode',
      '',
    );

    expect(resolved).toBeNull();
  });

  it('falls back to PATH lookup when no OpenCode CLI path is configured', () => {
    const pathDir = '/custom/bin';
    const pathBinary = path.join(pathDir, 'opencode');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === pathBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new OpencodeCliResolver();
    const resolved = resolver.resolve({}, '', `PATH=${pathDir}`);

    expect(resolved).toBe(pathBinary);
  });
});
