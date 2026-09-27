import * as fs from 'fs';

import { findClaudeBinaryPath } from '@/providers/claude/runtime/ClaudeBinaryLocator';
import { ClaudeCLIResolver } from '@/providers/claude/runtime/ClaudeCLIResolver';
import { getHostnameKey } from '@/utils/env';

jest.mock('fs');
jest.mock('@/utils/env', () => {
  const actual = jest.requireActual('@/utils/env');
  return {
    ...actual,
    getHostnameKey: jest.fn(() => 'test-host'),
  };
});
jest.mock('@/providers/claude/runtime/ClaudeBinaryLocator', () => {
  const actual = jest.requireActual('@/providers/claude/runtime/ClaudeBinaryLocator');
  return {
    ...actual,
    findClaudeBinaryPath: jest.fn(),
  };
});

const mockedStat = fs.statSync as jest.Mock;
const mockedFind = findClaudeBinaryPath as jest.Mock;
const mockedDeviceKey = getHostnameKey as jest.Mock;

describe('ClaudeCLIResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedDeviceKey.mockReturnValue('test-host');
  });

  describe('hostname-based resolution', () => {
    it('should use hostname path when available', () => {
      mockedStat.mockImplementation((p: string) => ({ isFile: () => p === '/hostname/claude' }));

      const resolver = new ClaudeCLIResolver();
      const resolved = resolver.resolveFromSettings({
        providerConfigs: { claude: { cliPathsByHost: { 'test-host': '/hostname/claude' }, cliPath: '/legacy/claude' } },
        sharedEnvironmentVariables: '',
      });

      expect(resolved).toBe('/hostname/claude');
    });

    it('should fall back to legacy path when hostname not found', () => {
      mockedStat.mockImplementation((p: string) => ({ isFile: () => p === '/legacy/claude' }));

      const resolver = new ClaudeCLIResolver();
      const resolved = resolver.resolveFromSettings({
        providerConfigs: { claude: { cliPathsByHost: { 'other-host': '/other/claude' }, cliPath: '/legacy/claude' } },
        sharedEnvironmentVariables: '',
      });

      expect(resolved).toBe('/legacy/claude');
    });

    it('should auto-detect when no paths configured', () => {
      mockedStat.mockImplementation(() => { throw new Error('Not found'); });
      mockedFind.mockReturnValue('/auto/claude');

      const resolver = new ClaudeCLIResolver();
      const resolved = resolver.resolveFromSettings({
        providerConfigs: { claude: { cliPathsByHost: {}, cliPath: '' } },
        sharedEnvironmentVariables: '',
      });

      expect(resolved).toBe('/auto/claude');
      expect(mockedFind).toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('retries a missing installation without a settings change', () => {
      mockedStat.mockImplementation(() => { throw new Error('Not found'); });
      mockedFind.mockReturnValueOnce(null).mockReturnValue('/installed/claude');
      const resolver = new ClaudeCLIResolver();

      expect(resolver.resolveFromSettings({})).toBeNull();
      expect(resolver.resolveFromSettings({})).toBe('/installed/claude');
      expect(resolver.resolveFromSettings({})).toBe('/installed/claude');
      expect(mockedFind).toHaveBeenCalledTimes(2);
    });

    it('should cache resolved path and return same result', () => {
      mockedStat.mockImplementation((p: string) => ({ isFile: () => p === '/hostname/claude' }));

      const resolver = new ClaudeCLIResolver();
      const first = resolver.resolveFromSettings({
        providerConfigs: { claude: { cliPathsByHost: { 'test-host': '/hostname/claude' }, cliPath: '' } },
        sharedEnvironmentVariables: '',
      });
      const second = resolver.resolveFromSettings({
        providerConfigs: { claude: { cliPathsByHost: { 'test-host': '/hostname/claude' }, cliPath: '' } },
        sharedEnvironmentVariables: '',
      });

      expect(first).toBe('/hostname/claude');
      expect(second).toBe('/hostname/claude');
      // statSync should be called only once due to caching
      expect(mockedStat).toHaveBeenCalledTimes(1);
    });

    it('should invalidate cache when hostname path changes', () => {
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new ClaudeCLIResolver();
      const first = resolver.resolveFromSettings({
        providerConfigs: { claude: { cliPathsByHost: { 'test-host': '/hostname/claude1' }, cliPath: '' } },
        sharedEnvironmentVariables: '',
      });
      const second = resolver.resolveFromSettings({
        providerConfigs: { claude: { cliPathsByHost: { 'test-host': '/hostname/claude2' }, cliPath: '' } },
        sharedEnvironmentVariables: '',
      });

      expect(first).toBe('/hostname/claude1');
      expect(second).toBe('/hostname/claude2');
    });

    it('should clear cache on reset()', () => {
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new ClaudeCLIResolver();
      resolver.resolveFromSettings({
        providerConfigs: { claude: { cliPathsByHost: { 'test-host': '/hostname/claude' }, cliPath: '' } },
        sharedEnvironmentVariables: '',
      });

      resolver.reset();

      resolver.resolveFromSettings({
        providerConfigs: { claude: { cliPathsByHost: { 'test-host': '/hostname/claude' }, cliPath: '' } },
        sharedEnvironmentVariables: '',
      });

      // Should be called twice because cache was cleared
      expect(mockedStat).toHaveBeenCalledTimes(2);
    });
  });

  describe('legacy compatibility', () => {
    it('should use legacy path as fallback when hostname paths are empty', () => {
      mockedStat.mockImplementation((p: string) => ({ isFile: () => p === '/legacy/claude' }));
      mockedFind.mockReturnValue('/auto/claude');

      const resolver = new ClaudeCLIResolver();
      const resolved = resolver.resolveFromSettings({
        providerConfigs: { claude: { cliPathsByHost: {}, cliPath: '/legacy/claude' } },
        sharedEnvironmentVariables: '',
      });

      expect(resolved).toBe('/legacy/claude');
      expect(mockedFind).not.toHaveBeenCalled();
    });

    it('should use legacy path when hostname paths are undefined', () => {
      mockedStat.mockImplementation((p: string) => ({ isFile: () => p === '/legacy/claude' }));
      mockedFind.mockReturnValue('/auto/claude');

      const resolver = new ClaudeCLIResolver();
      const resolved = resolver.resolveFromSettings({
        providerConfigs: { claude: { cliPathsByHost: undefined, cliPath: '/legacy/claude' } },
        sharedEnvironmentVariables: '',
      });

      expect(resolved).toBe('/legacy/claude');
      expect(mockedFind).not.toHaveBeenCalled();
    });
  });
});

describe('ClaudeCLIResolver path selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return hostname path when valid file exists', () => {
    mockedStat.mockImplementation((p: string) => ({ isFile: () => p === '/hostname/claude' }));

    const result = resolveClaudeCLIPath('/hostname/claude', '/legacy/claude', '');

    expect(result).toBe('/hostname/claude');
  });

  it('should skip hostname path if it is a directory', () => {
    mockedStat.mockImplementation((p: string) => ({
      isFile: () => p !== '/hostname/claude',
    }));

    const result = resolveClaudeCLIPath('/hostname/claude', '/legacy/claude', '');

    expect(result).toBe('/legacy/claude');
  });

  it('should handle empty hostname path gracefully', () => {
    mockedStat.mockImplementation((p: string) => ({ isFile: () => p === '/legacy/claude' }));

    const result = resolveClaudeCLIPath('', '/legacy/claude', '');

    expect(result).toBe('/legacy/claude');
  });

  it('should trim whitespace from paths', () => {
    mockedStat.mockImplementation((p: string) => ({ isFile: () => p === '/hostname/claude' }));

    const result = resolveClaudeCLIPath('  /hostname/claude  ', '', '');

    expect(result).toBe('/hostname/claude');
  });

  it('should handle null/undefined hostname path', () => {
    mockedStat.mockImplementation((p: string) => ({ isFile: () => p === '/legacy/claude' }));

    const result = resolveClaudeCLIPath(undefined, '/legacy/claude', '');

    expect(result).toBe('/legacy/claude');
  });

  it('should handle null/undefined legacy path', () => {
    mockedStat.mockImplementation(() => { throw new Error('Not found'); });
    mockedFind.mockReturnValue('/auto/claude');

    const result = resolveClaudeCLIPath('', undefined, '');

    expect(result).toBe('/auto/claude');
  });

  it('should fall through a missing hostname path', () => {
    mockedStat.mockImplementation((p: string) => {
      if (p === '/nonexistent/claude') throw new Error('Not found');
      return { isFile: () => p === '/legacy/claude' };
    });

    const result = resolveClaudeCLIPath('/nonexistent/claude', '/legacy/claude', '');

    expect(result).toBe('/legacy/claude');
  });

  it('should fall through hostname path when statSync throws', () => {
    mockedStat.mockImplementation((p: string) => {
      if (p.includes('nonexistent')) throw new Error('Access denied');
      return { isFile: () => p === '/legacy/claude' };
    });

    const result = resolveClaudeCLIPath('/nonexistent/claude', '/legacy/claude', '');

    expect(result).toBe('/legacy/claude');
  });

  it('should fall through legacy path when statSync throws', () => {
    mockedStat.mockImplementation(() => {
      throw new Error('Access denied');
    });
    mockedFind.mockReturnValue('/auto/claude');

    const result = resolveClaudeCLIPath('', '/bad/path', '');

    expect(result).toBe('/auto/claude');
  });

  it('should skip legacy path if it is a directory', () => {
    mockedStat.mockReturnValue({ isFile: () => false });
    mockedFind.mockReturnValue('/auto/claude');

    const result = resolveClaudeCLIPath('', '/legacy/dir', '');

    expect(result).toBe('/auto/claude');
  });

  it('should pass env PATH to findClaudeBinaryPath', () => {
    mockedStat.mockImplementation(() => { throw new Error('Not found'); });
    mockedFind.mockReturnValue(null);

    resolveClaudeCLIPath('', '', 'PATH=/custom/bin');

    expect(mockedFind).toHaveBeenCalledWith('/custom/bin');
  });
});

function resolveClaudeCLIPath(hostnamePath: string | undefined, legacyPath: string | undefined, envText: string): string | null {
  return new ClaudeCLIResolver().resolveFromSettings({
    providerConfigs: { claude: { cliPathsByHost: { [getHostnameKey()]: hostnamePath }, cliPath: legacyPath } },
    sharedEnvironmentVariables: envText,
  });
}
