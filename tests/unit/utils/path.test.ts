import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  expandHomePath,
  findClaudeCLIPath,
  getPathAccessType,
  isPathInAllowedExportPaths,
  isPathWithinVault,
  normalizePathForComparison,
  normalizePathForFilesystem,
  normalizePathForVault,
  parsePathEntries,
  translateMsysPath,
} from '@/utils/path';

const isWindows = process.platform === 'win32';

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

describe('isPathInAllowedExportPaths', () => {
  const vaultPath = path.resolve('/tmp/test-vault');

  it('returns false for empty allowedExportPaths', () => {
    expect(isPathInAllowedExportPaths('/some/path', [], vaultPath)).toBe(false);
  });

  it('returns true for path within allowed export path', () => {
    const exportDir = path.resolve('/tmp/exports');
    const candidate = path.join(exportDir, 'file.txt');
    expect(isPathInAllowedExportPaths(candidate, [exportDir], vaultPath)).toBe(true);
  });

  it('returns true for exact match of export path', () => {
    const exportDir = path.resolve('/tmp/exports');
    expect(isPathInAllowedExportPaths(exportDir, [exportDir], vaultPath)).toBe(true);
  });

  it('returns false for path outside all export paths', () => {
    const exportDir = path.resolve('/tmp/exports');
    expect(isPathInAllowedExportPaths('/other/path', [exportDir], vaultPath)).toBe(false);
  });

  it('checks multiple export paths', () => {
    const export1 = path.resolve('/tmp/export1');
    const export2 = path.resolve('/tmp/export2');
    const candidate = path.join(export2, 'file.txt');
    expect(isPathInAllowedExportPaths(candidate, [export1, export2], vaultPath)).toBe(true);
  });
});

describe('getPathAccessType', () => {
  const vaultPath = path.resolve('/tmp/test-vault');

  it('returns none for empty candidate', () => {
    expect(getPathAccessType('', [], [], vaultPath)).toBe('none');
  });

  it('returns vault for path inside vault', () => {
    const candidate = path.join(vaultPath, 'notes', 'file.md');
    expect(getPathAccessType(candidate, [], [], vaultPath)).toBe('vault');
  });

  it('returns vault for vault path itself', () => {
    expect(getPathAccessType(vaultPath, [], [], vaultPath)).toBe('vault');
  });

  it('returns vault for ~/.claude path', () => {
    const claudeDir = path.join(os.homedir(), '.claude', 'settings.json');
    expect(getPathAccessType(claudeDir, [], [], vaultPath)).toBe('vault');
  });

  it('returns context for path in context paths only', () => {
    const contextDir = path.resolve('/tmp/context-dir');
    const candidate = path.join(contextDir, 'file.md');
    expect(getPathAccessType(candidate, [contextDir], [], vaultPath)).toBe('context');
  });

  it('returns export for path in export paths only', () => {
    const exportDir = path.resolve('/tmp/export-dir');
    const candidate = path.join(exportDir, 'file.md');
    expect(getPathAccessType(candidate, [], [exportDir], vaultPath)).toBe('export');
  });

  it('returns readwrite for path in both context and export paths', () => {
    const sharedDir = path.resolve('/tmp/shared-dir');
    const candidate = path.join(sharedDir, 'file.md');
    expect(getPathAccessType(candidate, [sharedDir], [sharedDir], vaultPath)).toBe('readwrite');
  });

  it('returns none for path not in any allowed path', () => {
    const contextDir = path.resolve('/tmp/context-dir');
    expect(getPathAccessType('/other/path', [contextDir], [], vaultPath)).toBe('none');
  });

  it('handles undefined context and export paths', () => {
    expect(getPathAccessType('/some/path', undefined, undefined, vaultPath)).toBe('none');
  });

  it('uses most specific matching root', () => {
    const parentDir = path.resolve('/tmp/parent');
    const childDir = path.join(parentDir, 'child');
    const candidate = path.join(childDir, 'file.md');

    // Parent is context only, child is both context and export
    const result = getPathAccessType(
      candidate,
      [parentDir, childDir],
      [childDir],
      vaultPath
    );
    expect(result).toBe('readwrite');
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
      p => ({ isFile: () => String(p) === claudePath }) as fs.Stats
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
      p => ({ isFile: () => String(p) === commonPath }) as fs.Stats
    );

    const result = findClaudeCLIPath();
    expect(result).toBe(commonPath);
  });

  it('falls back to npm cli.js paths when binary not found', () => {
    const cliJsPath = path.join(
      os.homedir(), '.npm-global', 'lib', 'node_modules',
      '@anthropic-ai', 'claude-code', 'cli.js'
    );

    jest.spyOn(fs, 'existsSync').mockImplementation(
      p => String(p) === cliJsPath
    );
    jest.spyOn(fs, 'statSync').mockImplementation(
      p => ({ isFile: () => String(p) === cliJsPath }) as fs.Stats
    );

    const result = findClaudeCLIPath();
    expect(result).toBe(cliJsPath);
  });

  it('falls back to PATH environment when common and npm paths fail', () => {
    const envClaudePath = '/env/specific/bin/claude';
    const originalPath = process.env.PATH;
    process.env.PATH = `/env/specific/bin:${originalPath}`;

    jest.spyOn(fs, 'existsSync').mockImplementation(
      p => String(p) === envClaudePath
    );
    jest.spyOn(fs, 'statSync').mockImplementation(
      p => ({ isFile: () => String(p) === envClaudePath }) as fs.Stats
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

describe('getPathAccessType - edge cases', () => {
  const vaultPath = path.resolve('/tmp/test-vault');

  it('returns none when no root matches the candidate', () => {
    expect(getPathAccessType('/outside/path', ['  '], ['  '], vaultPath)).toBe('none');
  });
});
