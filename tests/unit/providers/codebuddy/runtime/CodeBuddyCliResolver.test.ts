import * as fs from 'fs';
import * as path from 'path';

import { CodeBuddyCliResolver } from '@/providers/codebuddy/runtime/CodeBuddyCliResolver';

jest.mock('fs');
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
}));

const mockedStat = fs.statSync as jest.Mock;

describe('CodeBuddyCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  it('resolves the current host path before the legacy CodeBuddy CLI path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/current/codebuddy') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new CodeBuddyCliResolver();

    expect(resolver.resolve({
      'current-host': '/current/codebuddy',
      'other-host': '/other/codebuddy',
    }, '/legacy/codebuddy')).toBe('/current/codebuddy');
  });

  it('falls back to cliPath and returns null for invalid paths', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/legacy/codebuddy') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new CodeBuddyCliResolver();
    expect(resolver.resolve({ 'other-host': '/other/codebuddy' }, '/legacy/codebuddy')).toBe('/legacy/codebuddy');

    mockedStat.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(resolver.resolve({ 'other-host': '/other/codebuddy' }, '/legacy/codebuddy')).toBeNull();
  });

  it('falls back to PATH codebuddy lookup when no CLI path is configured', () => {
    const pathDir = '/custom/bin';
    const pathBinary = path.join(pathDir, 'codebuddy');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === pathBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new CodeBuddyCliResolver();

    expect(resolver.resolve({}, '', `PATH=${pathDir}`)).toBe(pathBinary);
  });

  it('falls back to PATH cbc lookup when codebuddy is unavailable', () => {
    const pathDir = '/custom/bin';
    const pathBinary = path.join(pathDir, 'cbc');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === pathBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new CodeBuddyCliResolver();

    expect(resolver.resolve({}, '', `PATH=${pathDir}`)).toBe(pathBinary);
  });
});
