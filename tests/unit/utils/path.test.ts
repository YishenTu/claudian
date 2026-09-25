import type * as fsType from 'fs';
import type * as osType from 'os';
import type * as pathType from 'path';

const fs = jest.requireActual<typeof fsType>('fs');
const os = jest.requireActual<typeof osType>('os');
const path = jest.requireActual<typeof pathType>('path');

import {
  expandHomePath,
  getVaultPath,
  isPathWithinDirectory,
  isPathWithinVault,
  normalizeConfiguredCLIPath,
  normalizePathForComparison,
  normalizePathForFilesystem,
  normalizePathForVault,
  parsePathEntries,
  translateMsysPath,
} from '@/utils/path';

const isWindows = process.platform === 'win32';

describe('getVaultPath', () => {
  it('returns basePath when adapter exposes the property directly', () => {
    const mockApp = {
      vault: {
        adapter: {
          basePath: '/Users/test/my-vault',
        },
      },
    } as any;

    expect(getVaultPath(mockApp)).toBe('/Users/test/my-vault');
  });

  it('returns basePath for wrapped adapters that fail `in` checks', () => {
    const adapter = new Proxy(
      { basePath: '/Users/test/wrapped-vault' },
      {
        has: () => false,
      },
    );

    expect('basePath' in adapter).toBe(false);
    expect(getVaultPath({ vault: { adapter } } as any)).toBe('/Users/test/wrapped-vault');
  });

  it('returns null when adapter does not expose a string basePath', () => {
    expect(getVaultPath({ vault: { adapter: {} } } as any)).toBeNull();
    expect(getVaultPath({ vault: { adapter: { basePath: 123 } } } as any)).toBeNull();
  });

  it('returns null when adapter is undefined', () => {
    expect(getVaultPath({ vault: { adapter: undefined } } as any)).toBeNull();
  });

  it('preserves empty and platform-specific base paths', () => {
    expect(getVaultPath({ vault: { adapter: { basePath: '' } } } as any)).toBe('');
    expect(getVaultPath({ vault: { adapter: { basePath: '/Users/test/My Obsidian Vault' } } } as any)).toBe(
      '/Users/test/My Obsidian Vault',
    );
    expect(getVaultPath({ vault: { adapter: { basePath: 'C:\\Users\\test\\vault' } } } as any)).toBe(
      'C:\\Users\\test\\vault',
    );
  });
});

describe('expandHomePath', () => {
  it('expands ~ to home directory', () => {
    expect(expandHomePath('~')).toBe(os.homedir());
  });

  it('expands ~/ prefix', () => {
    const result = expandHomePath('~/Documents');
    expect(result).toBe(path.join(os.homedir(), 'Documents'));
  });

  it('expands nested ~/path', () => {
    const result = expandHomePath('~/a/b/c');
    expect(result).toBe(path.join(os.homedir(), 'a', 'b', 'c'));
  });

  it('returns non-tilde path unchanged', () => {
    expect(expandHomePath('/usr/local/bin')).toBe('/usr/local/bin');
  });

  it('does not expand ~ in middle of path', () => {
    expect(expandHomePath('/some/~/path')).toBe('/some/~/path');
  });

  it('expands $VAR format environment variables', () => {
    const original = process.env.TEST_EXPAND_VAR;
    process.env.TEST_EXPAND_VAR = '/custom/path';
    try {
      const result = expandHomePath('$TEST_EXPAND_VAR/bin');
      expect(result).toBe('/custom/path/bin');
    } finally {
      if (original === undefined) delete process.env.TEST_EXPAND_VAR;
      else process.env.TEST_EXPAND_VAR = original;
    }
  });

  it('expands ${VAR} format environment variables', () => {
    const original = process.env.TEST_EXPAND_VAR2;
    process.env.TEST_EXPAND_VAR2 = '/another/path';
    try {
      const result = expandHomePath('${TEST_EXPAND_VAR2}/lib');
      expect(result).toBe('/another/path/lib');
    } finally {
      if (original === undefined) delete process.env.TEST_EXPAND_VAR2;
      else process.env.TEST_EXPAND_VAR2 = original;
    }
  });

  it('expands %VAR% format environment variables', () => {
    const original = process.env.TEST_EXPAND_PCT;
    process.env.TEST_EXPAND_PCT = '/pct/path';
    try {
      const result = expandHomePath('%TEST_EXPAND_PCT%/dir');
      expect(result).toBe('/pct/path/dir');
    } finally {
      if (original === undefined) delete process.env.TEST_EXPAND_PCT;
      else process.env.TEST_EXPAND_PCT = original;
    }
  });

  it('preserves unmatched variable patterns', () => {
    delete process.env.NONEXISTENT_VAR_12345;
    expect(expandHomePath('$NONEXISTENT_VAR_12345/bin')).toBe('$NONEXISTENT_VAR_12345/bin');
    expect(expandHomePath('%NONEXISTENT_VAR_12345%/bin')).toBe('%NONEXISTENT_VAR_12345%/bin');
  });

  it('expands ~\\ backslash prefix', () => {
    const result = expandHomePath('~\\Documents');
    expect(result).toBe(path.join(os.homedir(), 'Documents'));
  });
});

describe('parsePathEntries', () => {
  it('returns empty array for undefined', () => {
    expect(parsePathEntries(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parsePathEntries('')).toEqual([]);
  });

  it('splits on platform separator', () => {
    const sep = isWindows ? ';' : ':';
    const entries = isWindows ? ['C:\\alpha', 'D:\\beta', 'E:\\gamma'] : ['/alpha', '/beta', '/gamma'];
    expect(parsePathEntries(entries.join(sep))).toEqual(entries);
  });

  it('filters out empty segments', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`${sep}/a${sep}${sep}/b${sep}`);
    expect(result).toEqual(isWindows ? ['A:', 'B:'] : ['/a', '/b']);
  });

  it('filters out $PATH placeholder', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`/a${sep}$PATH${sep}/b`);
    expect(result).toEqual(isWindows ? ['A:', 'B:'] : ['/a', '/b']);
  });

  it('filters out ${PATH} placeholder', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`/a${sep}\${PATH}${sep}/b`);
    expect(result).toEqual(isWindows ? ['A:', 'B:'] : ['/a', '/b']);
  });

  it('filters out %PATH% placeholder', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`/a${sep}%PATH%${sep}/b`);
    expect(result).toEqual(isWindows ? ['A:', 'B:'] : ['/a', '/b']);
  });

  it('strips surrounding double quotes', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`"/quoted/path"${sep}/normal`);
    expect(result[0]).toBe('/quoted/path');
  });

  it('strips surrounding single quotes', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`'/quoted/path'${sep}/normal`);
    expect(result[0]).toBe('/quoted/path');
  });

  it('expands ~ in entries', () => {
    const result = parsePathEntries('~/bin');
    expect(result[0]).toBe(path.join(os.homedir(), 'bin'));
  });
});

describe('normalizePathForFilesystem', () => {
  it('returns empty string for empty input', () => {
    expect(normalizePathForFilesystem('')).toBe('');
  });

  it('returns empty string for null-like input', () => {
    expect(normalizePathForFilesystem(null as any)).toBe('');
    expect(normalizePathForFilesystem(undefined as any)).toBe('');
  });

  it('returns empty string for non-string input', () => {
    expect(normalizePathForFilesystem(123 as any)).toBe('');
  });

  it('normalizes a regular path', () => {
    const result = normalizePathForFilesystem('/usr/local/bin');
    expect(result).toBe(path.join('/', 'usr', 'local', 'bin'));
  });

  it('normalizes path with redundant separators', () => {
    const result = normalizePathForFilesystem('/usr//local///bin');
    expect(result).toBe(path.join('/', 'usr', 'local', 'bin'));
  });

  it('normalizes path with . segments', () => {
    const result = normalizePathForFilesystem('/usr/./local/./bin');
    expect(result).toBe(path.join('/', 'usr', 'local', 'bin'));
  });

  it('normalizes path with .. segments', () => {
    const result = normalizePathForFilesystem('/usr/local/../bin');
    expect(result).toBe(path.join('/', 'usr', 'bin'));
  });

  it('expands ~ in path', () => {
    const result = normalizePathForFilesystem('~/Documents');
    expect(result).toBe(path.normalize(path.join(os.homedir(), 'Documents')));
  });

  it('expands environment variables', () => {
    const original = process.env.TEST_NORM_VAR;
    process.env.TEST_NORM_VAR = '/test/val';
    try {
      const result = normalizePathForFilesystem('$TEST_NORM_VAR/sub');
      expect(result).toBe(path.normalize('/test/val/sub'));
    } finally {
      if (original === undefined) delete process.env.TEST_NORM_VAR;
      else process.env.TEST_NORM_VAR = original;
    }
  });
});

describe('normalizePathForComparison', () => {
  it('returns empty string for empty input', () => {
    expect(normalizePathForComparison('')).toBe('');
  });

  it('returns empty string for null-like input', () => {
    expect(normalizePathForComparison(null as any)).toBe('');
    expect(normalizePathForComparison(undefined as any)).toBe('');
  });

  it('removes trailing slash', () => {
    const result = normalizePathForComparison('/usr/local/bin/');
    expect(result).toBe('/usr/local/bin');
  });

  it('removes multiple trailing slashes', () => {
    const result = normalizePathForComparison('/usr/local/bin///');
    expect(result).toBe('/usr/local/bin');
  });

  if (isWindows) {
    it('lowercases on Windows for case-insensitive comparison', () => {
      const result = normalizePathForComparison('C:\\Users\\Test');
      expect(result).toBe('c:/users/test');
    });
  }

  if (!isWindows) {
    it('preserves case on Unix', () => {
      const result = normalizePathForComparison('/Users/Test');
      expect(result).toContain('Test');
    });
  }

  it('normalizes redundant separators', () => {
    const result = normalizePathForComparison('/usr//local///bin');
    expect(result).toBe('/usr/local/bin');
  });
});

describe('isPathWithinVault', () => {
  const vaultPath = path.resolve('/tmp/test-vault');

  it('returns true for path within vault', () => {
    expect(isPathWithinVault(path.join(vaultPath, 'notes', 'file.md'), vaultPath)).toBe(true);
  });

  it('returns true for vault path itself', () => {
    expect(isPathWithinVault(vaultPath, vaultPath)).toBe(true);
  });

  it('returns false for path outside vault', () => {
    expect(isPathWithinVault('/completely/different/path', vaultPath)).toBe(false);
  });

  it('returns false for sibling directory', () => {
    expect(isPathWithinVault(path.resolve('/tmp/other-vault'), vaultPath)).toBe(false);
  });

  it('handles relative paths resolved against vault', () => {
    expect(isPathWithinVault('notes/file.md', vaultPath)).toBe(true);
  });
});

describe('isPathWithinDirectory', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('expands home paths before checking containment', () => {
    jest.spyOn(os, 'homedir').mockReturnValue('/home/test');

    expect(isPathWithinDirectory('~/.claude/settings.json', '/home/test/.claude', '/vault')).toBe(true);
  });

  it('blocks symlink escapes from the allowed directory', () => {
    const realpathMock = jest.fn((input: fsType.PathLike) => {
      const value = String(input);
      if (value === '/home/test/.claude') return '/home/test/.claude';
      if (value === '/home/test/.claude/skills/link') return '/home/test/.ssh';
      return path.resolve(value);
    });

    const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation(realpathMock as any);
    (realpathSpy as any).native = realpathMock;

    expect(isPathWithinDirectory('/home/test/.claude/skills/link', '/home/test/.claude', '/vault')).toBe(false);
  });
});

describe('normalizePathForVault', () => {
  const vaultPath = path.resolve('/tmp/test-vault');

  it('normalizes raw backslashes to vault-relative forward slashes', () => {
    expect(normalizePathForVault('notes\\subfolder\\file.md', vaultPath)).toBe('notes/subfolder/file.md');
  });

  it('preserves spaces in vault-relative paths', () => {
    expect(normalizePathForVault(path.join(vaultPath, 'my notes', 'file.md'), vaultPath)).toBe('my notes/file.md');
  });

  it('returns null when the path is the vault directory', () => {
    expect(normalizePathForVault(vaultPath, vaultPath)).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(normalizePathForVault(null, vaultPath)).toBeNull();
    expect(normalizePathForVault(undefined, vaultPath)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizePathForVault('', vaultPath)).toBeNull();
  });

  it('returns relative path for file within vault', () => {
    const fullPath = path.join(vaultPath, 'notes', 'file.md');
    const result = normalizePathForVault(fullPath, vaultPath);
    expect(result).toBe('notes/file.md');
  });

  it('returns normalized path for file outside vault', () => {
    const result = normalizePathForVault('/other/path/file.md', vaultPath);
    expect(result).toBe('/other/path/file.md');
  });

  it('handles null vaultPath', () => {
    const result = normalizePathForVault('/some/path.md', null);
    expect(result).toBe('/some/path.md');
  });
});

describe('expandHomePath - Windows environment variable formats', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('expands Windows !VAR! delayed expansion format on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const original = process.env.TEST_DELAYED;
    process.env.TEST_DELAYED = '/delayed/path';
    try {
      const result = expandHomePath('!TEST_DELAYED!/bin');
      expect(result).toBe('/delayed/path/bin');
    } finally {
      if (original === undefined) delete process.env.TEST_DELAYED;
      else process.env.TEST_DELAYED = original;
    }
  });

  it('does not expand !VAR! format on non-Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const original = process.env.TEST_DELAYED2;
    process.env.TEST_DELAYED2 = '/delayed/path2';
    try {
      const result = expandHomePath('!TEST_DELAYED2!/bin');
      expect(result).toBe('!TEST_DELAYED2!/bin');
    } finally {
      if (original === undefined) delete process.env.TEST_DELAYED2;
      else process.env.TEST_DELAYED2 = original;
    }
  });

  it('expands Windows $env:VAR PowerShell format on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const original = process.env.TEST_PSVAR;
    process.env.TEST_PSVAR = '/ps/path';
    try {
      const result = expandHomePath('$env:TEST_PSVAR/bin');
      expect(result).toBe('/ps/path/bin');
    } finally {
      if (original === undefined) delete process.env.TEST_PSVAR;
      else process.env.TEST_PSVAR = original;
    }
  });

  it('does not expand $env:VAR format on non-Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const original = process.env.TEST_PSVAR2;
    process.env.TEST_PSVAR2 = '/ps/path2';
    try {
      const result = expandHomePath('$env:TEST_PSVAR2/bin');
      // On non-Windows, $env is treated as a regular $VAR lookup for "env"
      // which won't match TEST_PSVAR2, so the $env: prefix persists partially
      expect(result).not.toBe('/ps/path2/bin');
    } finally {
      if (original === undefined) delete process.env.TEST_PSVAR2;
      else process.env.TEST_PSVAR2 = original;
    }
  });

  it('performs case-insensitive env lookup on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const original = process.env.MY_CI_VAR;
    process.env.MY_CI_VAR = '/ci/val';
    try {
      // %var% format uses getEnvValue which does case-insensitive search on Windows
      const result = expandHomePath('%my_ci_var%/test');
      expect(result).toBe('/ci/val/test');
    } finally {
      if (original === undefined) delete process.env.MY_CI_VAR;
      else process.env.MY_CI_VAR = original;
    }
  });
});

describe('normalizeConfiguredCLIPath', () => {
  it('strips surrounding double quotes from a path containing a space', () => {
    expect(normalizeConfiguredCLIPath('"/opt/my cli/claude"')).toBe('/opt/my cli/claude');
  });

  it('strips surrounding single quotes', () => {
    expect(normalizeConfiguredCLIPath("'/opt/claude'")).toBe('/opt/claude');
  });

  it('leaves an unquoted path unchanged', () => {
    expect(normalizeConfiguredCLIPath('/opt/my cli/claude')).toBe('/opt/my cli/claude');
  });

  it('leaves a path with only a leading quote unchanged', () => {
    expect(normalizeConfiguredCLIPath('"/opt/claude')).toBe('"/opt/claude');
  });

  it('trims surrounding whitespace before unquoting', () => {
    expect(normalizeConfiguredCLIPath('  "/opt/claude"  ')).toBe('/opt/claude');
  });

  it('expands environment variables after unquoting', () => {
    const original = process.env.TEST_QUOTED_CLI_DIR;
    process.env.TEST_QUOTED_CLI_DIR = '/opt/tools';
    try {
      expect(normalizeConfiguredCLIPath('"$TEST_QUOTED_CLI_DIR/my cli"')).toBe('/opt/tools/my cli');
    } finally {
      if (original === undefined) delete process.env.TEST_QUOTED_CLI_DIR;
      else process.env.TEST_QUOTED_CLI_DIR = original;
    }
  });

  it('expands a home-relative path after unquoting', () => {
    expect(normalizeConfiguredCLIPath('"~/bin/my cli"')).toBe(path.join(os.homedir(), 'bin/my cli'));
  });

  it('returns an empty string for blank or missing input', () => {
    expect(normalizeConfiguredCLIPath('   ')).toBe('');
    expect(normalizeConfiguredCLIPath(undefined)).toBe('');
  });
});

describe('filesystem path expansion and Windows prefixes', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('strips Windows device prefixes when platform is win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(normalizePathForFilesystem('\\\\?\\C:\\Users\\test\\file.txt')).toBe('C:\\Users\\test\\file.txt');
    expect(normalizePathForFilesystem('\\\\?\\UNC\\server\\share\\file.txt')).toBe('\\\\server\\share\\file.txt');
  });

  it('translates MSYS paths when platform is win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(normalizePathForFilesystem('/c/Users/test/file.txt')).toBe('C:\\Users\\test\\file.txt');
  });

  it('handles non-existent environment variables', () => {
    // Non-existent env vars should be left as-is
    expect(normalizePathForFilesystem('$NONEXISTENT/path')).toBe(path.join('$NONEXISTENT', 'path'));
    expect(normalizePathForFilesystem('%NONEXISTENT%/path')).toBe(path.join('%NONEXISTENT%', 'path'));
  });

  it('handles chained home and environment variable expansions', () => {
    const envKey = 'CLAUDIAN_TEST_SUBDIR';
    const originalValue = process.env[envKey];
    process.env[envKey] = 'project';

    try {
      const result = normalizePathForFilesystem(`~/$${envKey}/file.md`);
      const expected = path.join(os.homedir(), 'project', 'file.md');
      expect(result).toBe(expected);
    } finally {
      if (originalValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = originalValue;
      }
    }
  });

  it('handles Windows env vars with parentheses like ProgramFiles(x86)', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const originalPFx86 = process.env['ProgramFiles(x86)'];

    try {
      process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)';
      const result = normalizePathForFilesystem('%ProgramFiles(x86)%/app/file.txt');
      expect(result).toBe('C:\\Program Files (x86)\\app\\file.txt');
    } finally {
      if (originalPFx86 === undefined) {
        delete process.env['ProgramFiles(x86)'];
      } else {
        process.env['ProgramFiles(x86)'] = originalPFx86;
      }
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});

describe('relative Vault paths', () => {

  it('returns vault-relative path for relative input inside vault', () => {
    expect(normalizePathForVault('notes/a.md', '/vault')).toBe('notes/a.md');
  });
});

describe('Vault boundary edge cases', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should block path traversal escaping vault', () => {
    expect(isPathWithinVault('../secrets.txt', '/vault')).toBe(false);
  });

  it('should expand tilde and still enforce vault boundary', () => {
    jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
    expect(isPathWithinVault('~/vault/notes/a.md', '/vault')).toBe(false);
  });

  it('should allow exact vault path', () => {
    expect(isPathWithinVault('/vault', '/vault')).toBe(true);
    expect(isPathWithinVault('.', '/vault')).toBe(true);
  });

  it('should handle non-existent paths via fallback resolution', () => {
    // When fs.realpathSync throws (file doesn't exist), path.resolve is used
    jest.spyOn(fs, 'realpathSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    // Even with mock throwing, function should still work via fallback
    expect(isPathWithinVault('nonexistent/path.md', '/vault')).toBe(true);
  });

  it('should block symlink escapes for non-existent targets', () => {
    jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      const s = String(p);
      return s === '/' || s === '/vault' || s === '/vault/export';
    });

    const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation((p: any) => {
      const s = String(p);
      if (s === '/') return '/';
      if (s === '/vault') return '/vault';
      if (s === '/vault/export') return '/tmp/export';
      throw new Error('ENOENT');
    });
    (fs.realpathSync as any).native = realpathSpy;

    expect(isPathWithinVault('export/newfile.txt', '/vault')).toBe(false);
  });
});

describe('Windows separator normalization', () => {
  const originalPlatform = process.platform;
  const originalSep = path.sep;
  const originalIsAbsolute = path.isAbsolute;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    // Force Windows-style separator to detect regressions when comparisons rely on path.sep.
    Object.defineProperty(path, 'sep', { value: '\\', writable: true });
    jest.spyOn(path, 'isAbsolute').mockImplementation((p: any) => {
      const value = String(p);
      return /^[A-Za-z]:[\\/]/.test(value) || originalIsAbsolute(value);
    });

    const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation((p: any) => String(p) as any);
    (fs.realpathSync as any).native = realpathSpy;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(path, 'sep', { value: originalSep, writable: true });
    jest.restoreAllMocks();
  });

  it('allows vault paths after slash normalization', () => {
    expect(isPathWithinVault('C:\\Users\\test\\vault\\note.md', 'C:\\Users\\test\\vault')).toBe(true);
  });

});

describe('MSYS translation across simulated platforms', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('on Windows', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
    });

    it('should translate MSYS drive paths to Windows paths', () => {
      expect(translateMsysPath('/c/Users/test')).toBe('C:\\Users\\test');
      expect(translateMsysPath('/d/Projects/vault')).toBe('D:\\Projects\\vault');
    });

    it('should handle uppercase drive letters', () => {
      expect(translateMsysPath('/C/Users/test')).toBe('C:\\Users\\test');
    });

    it('should handle root drive paths', () => {
      expect(translateMsysPath('/c')).toBe('C:');
      expect(translateMsysPath('/c/')).toBe('C:\\');
    });

    it('should not translate non-MSYS absolute paths', () => {
      expect(translateMsysPath('/home/user')).toBe('/home/user');
      expect(translateMsysPath('/tmp/file.txt')).toBe('/tmp/file.txt');
    });

    it('should not translate Windows native paths', () => {
      expect(translateMsysPath('C:\\Users\\test')).toBe('C:\\Users\\test');
    });

    it('should not translate relative paths', () => {
      expect(translateMsysPath('./file.txt')).toBe('./file.txt');
      expect(translateMsysPath('../parent/file.txt')).toBe('../parent/file.txt');
    });
  });

  describe('on Unix', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
    });

    it('should not translate any paths', () => {
      expect(translateMsysPath('/c/Users/test')).toBe('/c/Users/test');
      expect(translateMsysPath('/home/user')).toBe('/home/user');
    });
  });
});
