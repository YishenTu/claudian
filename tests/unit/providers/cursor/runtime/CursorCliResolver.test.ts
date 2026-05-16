import * as fs from 'fs';

import { CursorCliResolver } from '@/providers/cursor/runtime/CursorCliResolver';

jest.mock('fs');
jest.mock('@/utils/env', () => {
  const actual = jest.requireActual('@/utils/env');
  return {
    ...actual,
    getHostnameKey: () => 'host-a',
    getEnhancedPath: (override?: string) => override ?? '/usr/local/bin:/usr/bin',
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

function settingsWith(cursorOverrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerConfigs: {
      cursor: {
        ...cursorOverrides,
      },
    },
    ...extra,
  };
}

describe('CursorCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when no path is configured and PATH probe finds nothing', () => {
    mockedFs.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const resolver = new CursorCliResolver();
    expect(resolver.resolveFromSettings(settingsWith())).toBeNull();
  });

  it('returns the host-scoped path when it exists on disk', () => {
    mockedFs.statSync.mockImplementation((p) => {
      if (p === '/host/cursor-agent') return { isFile: () => true } as fs.Stats;
      throw new Error('ENOENT');
    });

    const resolver = new CursorCliResolver();
    const settings = settingsWith({
      cliPathsByHost: { 'host-a': '/host/cursor-agent' },
      cliPath: '/legacy/cursor-agent',
    });
    expect(resolver.resolveFromSettings(settings)).toBe('/host/cursor-agent');
  });

  it('falls back to legacy cliPath when host-scoped path is missing', () => {
    mockedFs.statSync.mockImplementation((p) => {
      if (p === '/legacy/cursor-agent') return { isFile: () => true } as fs.Stats;
      throw new Error('ENOENT');
    });

    const resolver = new CursorCliResolver();
    const settings = settingsWith({ cliPath: '/legacy/cursor-agent' });
    expect(resolver.resolveFromSettings(settings)).toBe('/legacy/cursor-agent');
  });

  it('falls back to PATH probe when no configured paths resolve', () => {
    mockedFs.statSync.mockImplementation((p) => {
      if (p === '/usr/local/bin/cursor-agent') return { isFile: () => true } as fs.Stats;
      throw new Error('ENOENT');
    });

    const resolver = new CursorCliResolver();
    expect(resolver.resolveFromSettings(settingsWith())).toBe('/usr/local/bin/cursor-agent');
  });

  it('caches resolution while inputs are stable', () => {
    let calls = 0;
    mockedFs.statSync.mockImplementation((p) => {
      calls += 1;
      if (p === '/host/cursor-agent') return { isFile: () => true } as fs.Stats;
      throw new Error('ENOENT');
    });

    const resolver = new CursorCliResolver();
    const settings = settingsWith({ cliPathsByHost: { 'host-a': '/host/cursor-agent' } });

    const first = resolver.resolveFromSettings(settings);
    const callsAfterFirst = calls;
    const second = resolver.resolveFromSettings(settings);

    expect(first).toBe('/host/cursor-agent');
    expect(second).toBe('/host/cursor-agent');
    expect(calls).toBe(callsAfterFirst);
  });

  it('invalidates the cache when the host-scoped path changes', () => {
    let storedPath = '/host/cursor-agent';
    mockedFs.statSync.mockImplementation((p) => {
      if (p === storedPath) return { isFile: () => true } as fs.Stats;
      throw new Error('ENOENT');
    });

    const resolver = new CursorCliResolver();
    expect(resolver.resolveFromSettings(settingsWith({ cliPathsByHost: { 'host-a': '/host/cursor-agent' } })))
      .toBe('/host/cursor-agent');

    storedPath = '/host/new-cursor-agent';
    expect(resolver.resolveFromSettings(settingsWith({ cliPathsByHost: { 'host-a': '/host/new-cursor-agent' } })))
      .toBe('/host/new-cursor-agent');
  });

  it('invalidates the cache when env text changes', () => {
    mockedFs.statSync.mockImplementation((p) => {
      if (p === '/usr/local/bin/cursor-agent' || p === '/host/cursor-agent') {
        return { isFile: () => true } as fs.Stats;
      }
      throw new Error('ENOENT');
    });

    const resolver = new CursorCliResolver();

    const first = resolver.resolveFromSettings(settingsWith());
    expect(first).toBe('/usr/local/bin/cursor-agent');

    const next = resolver.resolveFromSettings(
      settingsWith({}, { sharedEnvironmentVariables: 'CURSOR_API_KEY=xyz' }),
    );
    expect(next).toBe('/usr/local/bin/cursor-agent');
  });

  it('reset() clears the cache', () => {
    mockedFs.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const resolver = new CursorCliResolver();
    expect(resolver.resolveFromSettings(settingsWith())).toBeNull();

    mockedFs.statSync.mockImplementation((p) => {
      if (p === '/host/cursor-agent') return { isFile: () => true } as fs.Stats;
      throw new Error('ENOENT');
    });
    resolver.reset();
    expect(resolver.resolveFromSettings(settingsWith({ cliPathsByHost: { 'host-a': '/host/cursor-agent' } })))
      .toBe('/host/cursor-agent');
  });
});
