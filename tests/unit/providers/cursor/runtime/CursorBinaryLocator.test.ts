import * as fs from 'fs';

import {
  findCursorAgentBinaryPath,
  isWindowsStyleCliReference,
  resolveCursorCliPath,
} from '@/providers/cursor/runtime/CursorBinaryLocator';

jest.mock('fs');
jest.mock('@/utils/env', () => {
  const actual = jest.requireActual('@/utils/env');
  return {
    ...actual,
    getEnhancedPath: (override?: string) => override ?? '/usr/local/bin:/usr/bin',
    parseEnvironmentVariables: actual.parseEnvironmentVariables,
  };
});
jest.mock('@/utils/path', () => {
  const actual = jest.requireActual('@/utils/path');
  return {
    ...actual,
    expandHomePath: (input: string) => input.replace(/^~/, '/home/user'),
    parsePathEntries: (value: string) => value.split(':').filter(Boolean),
  };
});

const mockedFs = fs as jest.Mocked<typeof fs>;

describe('isWindowsStyleCliReference', () => {
  it.each([
    'C:\\Users\\foo\\cursor-agent.exe',
    'D:/path/cursor-agent',
    '\\\\server\\share\\cursor-agent',
    '/opt/cursor-agent.cmd',
    'cursor-agent.exe',
  ])('detects %s as windows-style', (value) => {
    expect(isWindowsStyleCliReference(value)).toBe(true);
  });

  it.each([
    '',
    undefined,
    null,
    '/usr/local/bin/cursor-agent',
    'cursor-agent',
  ])('rejects %s', (value) => {
    expect(isWindowsStyleCliReference(value as string | null | undefined)).toBe(false);
  });
});

describe('findCursorAgentBinaryPath', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the first existing cursor-agent on PATH (posix)', () => {
    mockedFs.statSync.mockImplementation((p) => {
      if (typeof p === 'string' && p === '/usr/local/bin/cursor-agent') {
        return { isFile: () => true } as fs.Stats;
      }
      throw new Error('ENOENT');
    });

    const result = findCursorAgentBinaryPath('/usr/local/bin:/usr/bin', 'darwin');
    expect(result).toBe('/usr/local/bin/cursor-agent');
  });

  it('returns null when no cursor-agent is found', () => {
    mockedFs.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const result = findCursorAgentBinaryPath('/empty', 'darwin');
    expect(result).toBeNull();
  });

  it('searches windows binary names on win32', () => {
    const seen: string[] = [];
    mockedFs.statSync.mockImplementation((p) => {
      const str = typeof p === 'string' ? p : '';
      seen.push(str);
      if (str.endsWith('cursor-agent.cmd')) {
        return { isFile: () => true } as fs.Stats;
      }
      throw new Error('ENOENT');
    });

    const result = findCursorAgentBinaryPath('C:\\bin', 'win32');
    expect(result?.endsWith('cursor-agent.cmd')).toBe(true);
    expect(seen.some(p => p.endsWith('cursor-agent.exe'))).toBe(true);
  });
});

describe('resolveCursorCliPath', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prefers configured host-scoped path when it exists', () => {
    mockedFs.statSync.mockImplementation((p) => {
      if (p === '/host/cursor-agent') return { isFile: () => true } as fs.Stats;
      throw new Error('ENOENT');
    });

    const result = resolveCursorCliPath('/host/cursor-agent', '/legacy/path', '');
    expect(result).toBe('/host/cursor-agent');
  });

  it('falls back to legacy configured path when host path missing', () => {
    mockedFs.statSync.mockImplementation((p) => {
      if (p === '/legacy/cursor-agent') return { isFile: () => true } as fs.Stats;
      throw new Error('ENOENT');
    });

    const result = resolveCursorCliPath(undefined, '/legacy/cursor-agent', '');
    expect(result).toBe('/legacy/cursor-agent');
  });

  it('falls back to PATH probe when no configured paths resolve', () => {
    mockedFs.statSync.mockImplementation((p) => {
      if (p === '/usr/local/bin/cursor-agent') return { isFile: () => true } as fs.Stats;
      throw new Error('ENOENT');
    });

    const result = resolveCursorCliPath(undefined, undefined, '', { hostPlatform: 'darwin' });
    expect(result).toBe('/usr/local/bin/cursor-agent');
  });

  it('returns null when nothing resolves', () => {
    mockedFs.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = resolveCursorCliPath(undefined, undefined, '', { hostPlatform: 'darwin' });
    expect(result).toBeNull();
  });
});
