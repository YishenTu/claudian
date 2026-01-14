import * as fs from 'fs';
import * as os from 'os';

import { ClaudeCliResolver, resolveClaudeCliPath } from '@/utils/claudeCli';
import { findClaudeCLIPath } from '@/utils/path';

jest.mock('fs');
jest.mock('os');
jest.mock('@/utils/path', () => {
  const actual = jest.requireActual('@/utils/path');
  return {
    ...actual,
    findClaudeCLIPath: jest.fn(),
  };
});

const mockedExists = fs.existsSync as jest.Mock;
const mockedStat = fs.statSync as jest.Mock;
const mockedFind = findClaudeCLIPath as jest.Mock;
const mockedHostname = os.hostname as jest.Mock;

describe('ClaudeCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedHostname.mockReturnValue('test-host');
  });

  describe('hostname-based resolution', () => {
    it('should use hostname path when available', () => {
      mockedExists.mockImplementation((p: string) => p === '/hostname/claude');
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new ClaudeCliResolver();
      const resolved = resolver.resolve(
        { 'test-host': '/hostname/claude' },
        '/legacy/claude',
        ''
      );

      expect(resolved).toBe('/hostname/claude');
    });

    it('should fall back to legacy path when hostname not found', () => {
      mockedExists.mockImplementation((p: string) => p === '/legacy/claude');
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new ClaudeCliResolver();
      const resolved = resolver.resolve(
        { 'other-host': '/other/claude' },
        '/legacy/claude',
        ''
      );

      expect(resolved).toBe('/legacy/claude');
    });

    it('should fall back to legacy path when hostname paths empty', () => {
      mockedExists.mockImplementation((p: string) => p === '/legacy/claude');
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new ClaudeCliResolver();
      const resolved = resolver.resolve(
        {},
        '/legacy/claude',
        ''
      );

      expect(resolved).toBe('/legacy/claude');
    });

    it('should auto-detect when no paths configured', () => {
      mockedExists.mockReturnValue(false);
      mockedFind.mockReturnValue('/auto/claude');

      const resolver = new ClaudeCliResolver();
      const resolved = resolver.resolve({}, '', '');

      expect(resolved).toBe('/auto/claude');
      expect(mockedFind).toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('should cache resolved path and return same result', () => {
      mockedExists.mockImplementation((p: string) => p === '/hostname/claude');
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new ClaudeCliResolver();
      const first = resolver.resolve(
        { 'test-host': '/hostname/claude' },
        '',
        ''
      );
      const second = resolver.resolve(
        { 'test-host': '/hostname/claude' },
        '',
        ''
      );

      expect(first).toBe('/hostname/claude');
      expect(second).toBe('/hostname/claude');
      // existsSync should be called only once due to caching
      expect(mockedExists).toHaveBeenCalledTimes(1);
    });

    it('should invalidate cache when hostname path changes', () => {
      mockedExists.mockReturnValue(true);
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new ClaudeCliResolver();
      const first = resolver.resolve(
        { 'test-host': '/hostname/claude1' },
        '',
        ''
      );
      const second = resolver.resolve(
        { 'test-host': '/hostname/claude2' },
        '',
        ''
      );

      expect(first).toBe('/hostname/claude1');
      expect(second).toBe('/hostname/claude2');
    });

    it('should clear cache on reset()', () => {
      mockedExists.mockReturnValue(true);
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new ClaudeCliResolver();
      resolver.resolve(
        { 'test-host': '/hostname/claude' },
        '',
        ''
      );

      resolver.reset();

      resolver.resolve(
        { 'test-host': '/hostname/claude' },
        '',
        ''
      );

      // Should be called twice because cache was cleared
      expect(mockedExists).toHaveBeenCalledTimes(2);
    });
  });

  describe('legacy compatibility', () => {
    it('should use legacy path as fallback when hostname paths are empty', () => {
      mockedExists.mockImplementation((p: string) => p === '/legacy/claude');
      mockedStat.mockReturnValue({ isFile: () => true });
      mockedFind.mockReturnValue('/auto/claude');

      const resolver = new ClaudeCliResolver();
      const resolved = resolver.resolve({}, '/legacy/claude', '');

      expect(resolved).toBe('/legacy/claude');
      expect(mockedFind).not.toHaveBeenCalled();
    });

    it('should use legacy path when hostname paths are undefined', () => {
      mockedExists.mockImplementation((p: string) => p === '/legacy/claude');
      mockedStat.mockReturnValue({ isFile: () => true });
      mockedFind.mockReturnValue('/auto/claude');

      const resolver = new ClaudeCliResolver();
      const resolved = resolver.resolve(undefined, '/legacy/claude', '');

      expect(resolved).toBe('/legacy/claude');
      expect(mockedFind).not.toHaveBeenCalled();
    });
  });
});

describe('resolveClaudeCliPath', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return hostname path when valid file exists', () => {
    mockedExists.mockImplementation((p: string) => p === '/hostname/claude');
    mockedStat.mockReturnValue({ isFile: () => true });

    const result = resolveClaudeCliPath('/hostname/claude', '/legacy/claude', '');

    expect(result).toBe('/hostname/claude');
  });

  it('should skip hostname path if it is a directory', () => {
    mockedExists.mockReturnValue(true);
    mockedStat.mockImplementation((p: string) => ({
      isFile: () => p !== '/hostname/claude',
    }));

    const result = resolveClaudeCliPath('/hostname/claude', '/legacy/claude', '');

    expect(result).toBe('/legacy/claude');
  });

  it('should handle empty hostname path gracefully', () => {
    mockedExists.mockImplementation((p: string) => p === '/legacy/claude');
    mockedStat.mockReturnValue({ isFile: () => true });

    const result = resolveClaudeCliPath('', '/legacy/claude', '');

    expect(result).toBe('/legacy/claude');
  });

  it('should trim whitespace from paths', () => {
    mockedExists.mockImplementation((p: string) => p === '/hostname/claude');
    mockedStat.mockReturnValue({ isFile: () => true });

    const result = resolveClaudeCliPath('  /hostname/claude  ', '', '');

    expect(result).toBe('/hostname/claude');
  });
});
