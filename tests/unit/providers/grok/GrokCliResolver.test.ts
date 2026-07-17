import * as fs from 'fs';
import * as path from 'path';

import { GrokCliResolver } from '@/providers/grok/runtime/GrokCliResolver';

jest.mock('fs');
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
}));

const mockedStat = fs.statSync as jest.Mock;

describe('GrokCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  it('uses the current host path instead of another synced host path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/current/grok') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new GrokCliResolver();
    const resolved = resolver.resolve(
      {
        'other-host': '/other/grok',
        'current-host': '/current/grok',
      },
      '/legacy/grok',
      '',
    );

    expect(resolved).toBe('/current/grok');
  });

  it('falls back to the legacy path when the current host has no custom path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/legacy/grok') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new GrokCliResolver();
    const resolved = resolver.resolve(
      {
        'other-host': '/other/grok',
      },
      '/legacy/grok',
      '',
    );

    expect(resolved).toBe('/legacy/grok');
  });

  it('falls back to PATH lookup when no Grok CLI path is configured', () => {
    const pathDir = '/custom/bin';
    const pathBinary = path.join(pathDir, 'grok');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === pathBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new GrokCliResolver();
    const resolved = resolver.resolve({}, '', `PATH=${pathDir}`);

    expect(resolved).toBe(pathBinary);
  });

  it('returns null when no configured path or PATH binary exists', () => {
    mockedStat.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const resolver = new GrokCliResolver();
    const resolved = resolver.resolve(
      {
        'other-host': '/other/grok',
      },
      '/legacy/grok',
      '',
    );

    expect(resolved).toBeNull();
  });
});
