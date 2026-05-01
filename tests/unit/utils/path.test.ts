import type * as fsType from 'fs';
import type * as osType from 'os';
import type * as pathType from 'path';

const fs = jest.requireActual<typeof fsType>('fs');
const os = jest.requireActual<typeof osType>('os');
const path = jest.requireActual<typeof pathType>('path');

import { findClaudeCLIPath } from '@/providers/claude/cli/findClaudeCLIPath';
import {
  expandHomePath,
  getVaultPath,
  isPathWithinDirectory,
  isPathWithinVault,
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
  });

  it('returns path unchanged when no special patterns', () => {
    expect(expandHomePath('/plain/path')).toBe('/plain/path');
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
    const result = parsePathEntries(`/a${sep}/b${sep}/c`);
    expect(result).toContain('/a');
    expect(result).toContain('/b');
    expect(result).toContain('/c');
  });

  it('filters out empty segments', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`${sep}/a${sep}${sep}/b${sep}`);
    expect(result.every(s => s.length > 0)).toBe(true);
  });

  it('filters out $PATH placeholder', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`/a${sep}$PATH${sep}/b`);
    expect(result).not.toContain('$PATH');
  });

  it('filters out ${PATH} placeholder', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`/a${sep}\${PATH}${sep}/b`);
    expect(result).not.toContain('${PATH}');
  });

  it('filters out %PATH% placeholder', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`/a${sep}%PATH%${sep}/b`);
    expect(result).not.toContain('%PATH%');
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

describe('translateMsysPath', () => {
  if (!isWindows) {
    it('returns value unchanged on non-Windows', () => {
      expect(translateMsysPath('/c/Users/test')).toBe('/c/Users/test');
    });
  }

  if (isWindows) {
    it('translates /c/ to C:\\ on Windows', () => {
      expect(translateMsysPath('/c/Users/test')).toBe('C:\\Users\\test');
    });

    it('translates uppercase drive letter', () => {
      expect(translateMsysPath('/D/projects')).toBe('D:\\projects');
    });

    it('returns non-msys path unchanged', () => {
      expect(translateMsysPath('C:\\Users\\test')).toBe('C:\\Users\\test');
    });
  }
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
    expect(result).toBe('/usr/local/bin');
  });

  it('normalizes path with redundant separators', () => {
    const result = normalizePathForFilesystem('/usr//local///bin');
    expect(result).toBe('/usr/local/bin');
  });

  it('normalizes path with . segments', () => {
    const result = normalizePathForFilesystem('/usr/./local/./bin');
    expect(result).toBe('/usr/local/bin');
  });

  it('normalizes path with .. segments', () => {
    const result = normalizePathForFilesystem('/usr/local/../bin');
    expect(result).toBe('/usr/bin');
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

  it('normalizes slashes to forward slash', () => {
    // On any platform, result should use forward slashes
    const result = normalizePathForComparison('/usr/local/bin');
    expect(result).not.toContain('\\');
  });

  it('removes trailing slash', () => {
    const result = normalizePathForComparison('/usr/local/bin/');
    expect(result).not.toMatch(/\/$/);
  });

  it('removes multiple trailing slashes', () => {
    const result = normalizePathForComparison('/usr/local/bin///');
    expect(result).not.toMatch(/\/$/);
  });

  if (isWindows) {
    it('lowercases on Windows for case-insensitive comparison', () => {
      const result = normalizePathForComparison('C:\\Users\\Test');
      expect(result).toBe(result.toLowerCase());
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

    (fs.realpathSync as any) = realpathMock;
    (fs.realpathSync as any).native = realpathMock;

    expect(isPathWithinDirectory('/home/test/.claude/skills/link', '/home/test/.claude', '/vault')).toBe(false);
  });
});

describe('normalizePathForVault', () => {
  const vaultPath = path.resolve('/tmp/test-vault');

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
    expect(result).toContain('file.md');
  });

  it('uses forward slashes in result', () => {
    const fullPath = path.join(vaultPath, 'a', 'b', 'c.md');
    const result = normalizePathForVault(fullPath, vaultPath);
    expect(result).not.toContain('\\');
  });

  it('handles null vaultPath', () => {
    const result = normalizePathForVault('/some/path.md', null);
    expect(result).toContain('path.md');
  });
});

describe('findClaudeCLIPath', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns null when nothing found', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const result = findClaudeCLIPath('/nonexistent/path');
    expect(result).toBeNull();
  });

  it('resolves from custom path entries', () => {
    const claudePath = isWindows
      ? 'C:\\custom\\bin\\claude.exe'
      : '/custom/bin/claude';

    jest.spyOn(fs, 'existsSync').mockImplementation(
      p => String(p) === claudePath
    );
    jest.spyOn(fs, 'statSync').mockImplementation(
      p => ({ isFile: () => String(p) === claudePath }) as fsType.Stats
    );

    const result = findClaudeCLIPath(isWindows ? 'C:\\custom\\bin' : '/custom/bin');
    expect(result).toBe(claudePath);
  });

  it('returns string or null', () => {
    const result = findClaudeCLIPath();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('finds claude from common paths when no custom path provided', () => {
    const commonPath = path.join(os.homedir(), '.claude', 'local', 'claude');

    jest.spyOn(fs, 'existsSync').mockImplementation(
      p => String(p) === commonPath
    );
    jest.spyOn(fs, 'statSync').mockImplementation(
      p => ({ isFile: () => String(p) === commonPath }) as fsType.Stats
    );

    const result = findClaudeCLIPath();
    expect(result).toBe(commonPath);
  });

  it('falls back to npm cli-wrapper.cjs paths when binary not found', () => {
    const cliWrapperPath = path.join(
      os.homedir(), '.npm-global', 'lib', 'node_modules',
      '@anthropic-ai', 'claude-code', 'cli-wrapper.cjs'
    );

    jest.spyOn(fs, 'existsSync').mockImplementation(
      p => String(p) === cliWrapperPath
    );
    jest.spyOn(fs, 'statSync').mockImplementation(
      p => ({ isFile: () => String(p) === cliWrapperPath }) as fsType.Stats
    );

    const result = findClaudeCLIPath();
    expect(result).toBe(cliWrapperPath);
  });

  it('keeps legacy npm cli.js fallback when cli-wrapper.cjs is absent', () => {
    const legacyCliPath = path.join(
      os.homedir(), '.npm-global', 'lib', 'node_modules',
      '@anthropic-ai', 'claude-code', 'cli.js'
    );

    jest.spyOn(fs, 'existsSync').mockImplementation(
      p => String(p) === legacyCliPath
    );
    jest.spyOn(fs, 'statSync').mockImplementation(
      p => ({ isFile: () => String(p) === legacyCliPath }) as fsType.Stats
    );

    const result = findClaudeCLIPath();
    expect(result).toBe(legacyCliPath);
  });

  it('falls back to PATH environment when common and npm paths fail', () => {
    const envClaudePath = '/env/specific/bin/claude';
    const originalPath = process.env.PATH;
    process.env.PATH = `/env/specific/bin:${originalPath}`;

    jest.spyOn(fs, 'existsSync').mockImplementation(
      p => String(p) === envClaudePath
    );
    jest.spyOn(fs, 'statSync').mockImplementation(
      p => ({ isFile: () => String(p) === envClaudePath }) as fsType.Stats
    );

    try {
      const result = findClaudeCLIPath();
      expect(result).toBe(envClaudePath);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('returns null for custom path without claude binary on non-Windows', () => {
    // On non-Windows, custom path resolution only looks for 'claude' binary
    const customDir = '/custom/tools';

    jest.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = findClaudeCLIPath(customDir);
    expect(result).toBeNull();
  });

  it('handles inaccessible filesystem paths gracefully', () => {
    jest.spyOn(fs, 'existsSync').mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const result = findClaudeCLIPath('/some/path');
    expect(result).toBeNull();
  });

  it('finds claude via nvm default version when NVM_BIN is not set (Unix)', () => {
    if (isWindows) return;

    const savedNvmBin = process.env.NVM_BIN;
    const savedNvmDir = process.env.NVM_DIR;
    delete process.env.NVM_BIN;
    delete process.env.NVM_DIR;

    const nvmDir = '/fake/home/.nvm';
    const claudePath = path.join(nvmDir, 'versions', 'node', 'v22.18.0', 'bin', 'claude');
    const binDir = path.join(nvmDir, 'versions', 'node', 'v22.18.0', 'bin');

    jest.spyOn(os, 'homedir').mockReturnValue('/fake/home');
    jest.spyOn(fs, 'existsSync').mockImplementation(p => {
      const s = String(p);
      return s === claudePath || s === binDir;
    });
    jest.spyOn(fs, 'readFileSync').mockImplementation(((p: string) => {
      if (String(p) === path.join(nvmDir, 'alias', 'default')) return '22';
      throw new Error('not found');
    }) as typeof fs.readFileSync);
    jest.spyOn(fs, 'readdirSync').mockImplementation(((p: string) => {
      if (String(p) === path.join(nvmDir, 'versions', 'node')) return ['v22.18.0'];
      return [];
    }) as typeof fs.readdirSync);
    jest.spyOn(fs, 'statSync').mockImplementation(
      () => ({ isFile: () => true }) as fsType.Stats
    );

    const result = findClaudeCLIPath();
    expect(result).toBe(claudePath);

    if (savedNvmBin !== undefined) process.env.NVM_BIN = savedNvmBin;
    else delete process.env.NVM_BIN;
    if (savedNvmDir !== undefined) process.env.NVM_DIR = savedNvmDir;
    else delete process.env.NVM_DIR;
  });

  it('finds claude via built-in nvm node alias when NVM_BIN is not set (Unix)', () => {
    if (isWindows) return;

    const savedNvmBin = process.env.NVM_BIN;
    const savedNvmDir = process.env.NVM_DIR;
    delete process.env.NVM_BIN;
    delete process.env.NVM_DIR;

    const nvmDir = '/fake/home/.nvm';
    const claudePath = path.join(nvmDir, 'versions', 'node', 'v22.18.0', 'bin', 'claude');
    const binDir = path.join(nvmDir, 'versions', 'node', 'v22.18.0', 'bin');

    jest.spyOn(os, 'homedir').mockReturnValue('/fake/home');
    jest.spyOn(fs, 'existsSync').mockImplementation(p => {
      const s = String(p);
      return s === claudePath || s === binDir;
    });
    jest.spyOn(fs, 'readFileSync').mockImplementation(((p: string) => {
      if (String(p) === path.join(nvmDir, 'alias', 'default')) return 'node';
      throw new Error('not found');
    }) as typeof fs.readFileSync);
    jest.spyOn(fs, 'readdirSync').mockImplementation(((p: string) => {
      if (String(p) === path.join(nvmDir, 'versions', 'node')) return ['v20.10.0', 'v22.18.0'];
      return [];
    }) as typeof fs.readdirSync);
    jest.spyOn(fs, 'statSync').mockImplementation(
      () => ({ isFile: () => true }) as fsType.Stats
    );

    const result = findClaudeCLIPath();
    expect(result).toBe(claudePath);

    if (savedNvmBin !== undefined) process.env.NVM_BIN = savedNvmBin;
    else delete process.env.NVM_BIN;
    if (savedNvmDir !== undefined) process.env.NVM_DIR = savedNvmDir;
    else delete process.env.NVM_DIR;
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
