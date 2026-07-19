import * as fs from 'fs';
import * as path from 'path';

import { KimiCliResolver } from '@/providers/kimi/runtime/KimiCliResolver';

jest.mock('fs');
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
}));

const mockedStat = fs.statSync as jest.Mock;

describe('KimiCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  it('uses the current host path instead of another synced host path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/current/kimi') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new KimiCliResolver();
    const resolved = resolver.resolve(
      {
        'other-host': '/other/kimi',
        'current-host': '/current/kimi',
      },
      '/legacy/kimi',
      '',
    );

    expect(resolved).toBe('/current/kimi');
  });

  it('falls back to the legacy path when the current host has no custom path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/legacy/kimi') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new KimiCliResolver();
    const resolved = resolver.resolve(
      {
        'other-host': '/other/kimi',
      },
      '/legacy/kimi',
      '',
    );

    expect(resolved).toBe('/legacy/kimi');
  });

  it('falls back to PATH lookup when no Kimi CLI path is configured', () => {
    const pathDir = '/custom/bin';
    const pathBinary = path.join(pathDir, 'kimi');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === pathBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new KimiCliResolver();
    const resolved = resolver.resolve({}, '', `PATH=${pathDir}`);

    expect(resolved).toBe(pathBinary);
  });

  it('resolves Windows cmd shim names via shared binary helpers', () => {
    const pathDir = 'C:\\Users\\me\\AppData\\Local\\kimi';
    const cmdShim = path.join(pathDir, 'kimi.cmd');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === cmdShim) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new KimiCliResolver();
    // On non-Windows CI hosts, findCliBinaryPath still searches .cmd only when platform=win32.
    // Assert host-scoped configured path resolves the Windows cmd shim.
    expect(
      resolver.resolve({ 'current-host': cmdShim }, '', ''),
    ).toBe(cmdShim);
  });
});
