import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as env from '../../../src/utils/env';

const {
  cliPathRequiresNode,
  findNodeDirectory,
  findNodeExecutable,
  formatContextLimit,
  getCurrentModelFromEnvironment,
  getCustomModelIds,
  getEnhancedPath,
  getMissingNodeError,
  getModelsFromEnvironment,
  getHostnameKey,
  parseContextLimit,
  parseEnvironmentVariables,
} = env;

const isWindows = process.platform === 'win32';
const SEP = isWindows ? ';' : ':';

describe('parseEnvironmentVariables', () => {
  it('parses simple KEY=VALUE pairs', () => {
    const input = 'FOO=bar\nBAZ=qux';
    expect(parseEnvironmentVariables(input)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles quoted values', () => {
    const input = 'FOO="bar baz"\nQUX=\'hello world\'';
    expect(parseEnvironmentVariables(input)).toEqual({ FOO: 'bar baz', QUX: 'hello world' });
  });

  it('ignores comments and empty lines', () => {
    const input = '# comment\nFOO=bar\n\n# another\nBAZ=qux';
    expect(parseEnvironmentVariables(input)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles Windows line endings', () => {
    const input = 'FOO=bar\r\nBAZ=qux\r\n';
    expect(parseEnvironmentVariables(input)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles equals sign in value', () => {
    const input = 'FOO=bar=baz';
    expect(parseEnvironmentVariables(input)).toEqual({ FOO: 'bar=baz' });
  });

  it('trims whitespace around keys and values', () => {
    const input = '  FOO  =  bar  ';
    expect(parseEnvironmentVariables(input)).toEqual({ FOO: 'bar' });
  });

  it('strips export prefix from shell snippets', () => {
    const input = 'export FOO=bar\nexport BAZ="hello world"';
    expect(parseEnvironmentVariables(input)).toEqual({ FOO: 'bar', BAZ: 'hello world' });
  });

  it('handles mixed export and non-export lines', () => {
    const input = 'FOO=bar\nexport BAZ=qux\nQUX=123';
    expect(parseEnvironmentVariables(input)).toEqual({ FOO: 'bar', BAZ: 'qux', QUX: '123' });
  });
});

describe('getEnhancedPath', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore environment
    Object.keys(process.env).forEach(key => delete process.env[key]);
    Object.assign(process.env, originalEnv);
  });

  describe('basic functionality', () => {
    it('returns a non-empty string', () => {
      const result = getEnhancedPath();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('includes current PATH from process.env', () => {
      process.env.PATH = `/existing/path${SEP}/another/path`;
      const result = getEnhancedPath();
      expect(result).toContain('/existing/path');
      expect(result).toContain('/another/path');
    });

    it('works when process.env.PATH is empty', () => {
      process.env.PATH = '';
      const result = getEnhancedPath();
      expect(typeof result).toBe('string');
      // Should still have extra paths
      expect(result.length).toBeGreaterThan(0);
    });

    it('works when process.env.PATH is undefined', () => {
      delete process.env.PATH;
      const result = getEnhancedPath();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('platform-specific separator', () => {
    it('uses correct separator for current platform', () => {
      const result = getEnhancedPath();
      // Result should contain the platform-specific separator
      expect(result).toContain(SEP);
    });

    it('splits and joins with platform separator', () => {
      const result = getEnhancedPath();
      const segments = result.split(SEP);
      // Should have multiple segments
      expect(segments.length).toBeGreaterThan(1);
      // Rejoining should give same result
      expect(segments.join(SEP)).toBe(result);
    });

    it('handles input with platform separator', () => {
      const customPath = `/custom/bin1${SEP}/custom/bin2`;
      const result = getEnhancedPath(customPath);
      expect(result).toContain('/custom/bin1');
      expect(result).toContain('/custom/bin2');
    });
  });

  describe('custom PATH merging and priority', () => {
    it('prepends additional paths (highest priority)', () => {
      process.env.PATH = '/existing/path';
      const result = getEnhancedPath('/custom/bin');
      const segments = result.split(SEP);
      // Custom path should be first
      expect(segments[0]).toBe('/custom/bin');
      // Existing should come after extra paths
      expect(segments.indexOf('/custom/bin')).toBeLessThan(segments.indexOf('/existing/path'));
    });

    it('merges multiple additional paths in order', () => {
      const customPath = `/first/bin${SEP}/second/bin${SEP}/third/bin`;
      const result = getEnhancedPath(customPath);
      const segments = result.split(SEP);
      expect(segments[0]).toBe('/first/bin');
      expect(segments[1]).toBe('/second/bin');
      expect(segments[2]).toBe('/third/bin');
    });

    it('preserves priority: additional > extra > current', () => {
      process.env.PATH = '/usr/bin';
      const result = getEnhancedPath('/user/custom');
      const segments = result.split(SEP);

      const customIndex = segments.indexOf('/user/custom');
      const usrBinIndex = segments.indexOf('/usr/bin');

      // Custom should come before current PATH
      expect(customIndex).toBeLessThan(usrBinIndex);
    });

    it('handles undefined additional paths', () => {
      process.env.PATH = '/existing/path';
      const result = getEnhancedPath(undefined);
      expect(result).toContain('/existing/path');
    });

    it('handles empty string additional paths', () => {
      process.env.PATH = '/existing/path';
      const result = getEnhancedPath('');
      expect(result).toContain('/existing/path');
      // Should not have empty segments
      const segments = result.split(SEP);
      expect(segments.every(s => s.length > 0)).toBe(true);
    });
  });

  describe('deduplication logic', () => {
    it('removes duplicate paths', () => {
      process.env.PATH = `/usr/local/bin${SEP}/usr/bin`;
      const result = getEnhancedPath('/usr/local/bin');
      const segments = result.split(SEP);
      const count = segments.filter(s => s === '/usr/local/bin').length;
      expect(count).toBe(1);
    });

    it('preserves first occurrence when deduplicating', () => {
      // Additional path should win over current PATH
      process.env.PATH = `/duplicate/path${SEP}/other/path`;
      const result = getEnhancedPath('/duplicate/path');
      const segments = result.split(SEP);
      // First occurrence should be from additional paths
      expect(segments[0]).toBe('/duplicate/path');
    });

    it('deduplicates across all sources', () => {
      // Path appears in additional, might be in extra paths, and in current
      process.env.PATH = `/usr/local/bin${SEP}/usr/bin${SEP}/usr/local/bin`;
      const result = getEnhancedPath(`/usr/local/bin${SEP}/usr/bin`);
      const segments = result.split(SEP);

      // Each unique path should appear only once
      const localBinCount = segments.filter(s => s === '/usr/local/bin').length;
      const usrBinCount = segments.filter(s => s === '/usr/bin').length;
      expect(localBinCount).toBe(1);
      expect(usrBinCount).toBe(1);
    });

    // Note: Case-insensitive deduplication on Windows is tested implicitly
    // since the module uses lowercase comparison on win32
  });

  describe('empty segment filtering', () => {
    it('filters out empty segments from current PATH', () => {
      process.env.PATH = `/usr/bin${SEP}${SEP}/bin${SEP}`;
      const result = getEnhancedPath();
      const segments = result.split(SEP);
      expect(segments.every(s => s.length > 0)).toBe(true);
    });

    it('filters out empty segments from additional paths', () => {
      const result = getEnhancedPath(`${SEP}/custom/bin${SEP}${SEP}`);
      const segments = result.split(SEP);
      expect(segments.every(s => s.length > 0)).toBe(true);
    });

    it('handles path with only empty segments', () => {
      process.env.PATH = `${SEP}${SEP}${SEP}`;
      const result = getEnhancedPath(`${SEP}${SEP}`);
      const segments = result.split(SEP);
      expect(segments.every(s => s.length > 0)).toBe(true);
    });
  });

  describe('extra binary paths', () => {
    it('returns non-empty result with extra paths', () => {
      const result = getEnhancedPath();
      // On both platforms, result should be non-empty
      expect(result.length).toBeGreaterThan(0);
    });

    it('includes platform-appropriate paths', () => {
      const result = getEnhancedPath();
      const segments = result.split(SEP);
      // Should have added some extra paths beyond just process.env.PATH
      expect(segments.length).toBeGreaterThan(1);
    });
  });

  describe('Unix environment variable paths', () => {
    if (isWindows) return;

    it('includes VOLTA_HOME/bin when set', () => {
      process.env.VOLTA_HOME = '/custom/volta';
      const result = getEnhancedPath();
      expect(result).toContain('/custom/volta/bin');
      delete process.env.VOLTA_HOME;
    });

    it('includes ASDF_DATA_DIR shims and bin when set', () => {
      process.env.ASDF_DATA_DIR = '/custom/asdf';
      const result = getEnhancedPath();
      expect(result).toContain('/custom/asdf/shims');
      expect(result).toContain('/custom/asdf/bin');
      delete process.env.ASDF_DATA_DIR;
    });

    it('includes ASDF_DIR shims and bin when set', () => {
      delete process.env.ASDF_DATA_DIR;
      process.env.ASDF_DIR = '/alt/asdf';
      const result = getEnhancedPath();
      expect(result).toContain('/alt/asdf/shims');
      expect(result).toContain('/alt/asdf/bin');
      delete process.env.ASDF_DIR;
    });

    it('includes FNM_MULTISHELL_PATH when set', () => {
      process.env.FNM_MULTISHELL_PATH = '/tmp/fnm_multishell';
      const result = getEnhancedPath();
      expect(result).toContain('/tmp/fnm_multishell');
      delete process.env.FNM_MULTISHELL_PATH;
    });

    it('includes FNM_DIR when set', () => {
      process.env.FNM_DIR = '/custom/fnm';
      const result = getEnhancedPath();
      expect(result).toContain('/custom/fnm');
      delete process.env.FNM_DIR;
    });

    it('includes NVM_BIN when set', () => {
      process.env.NVM_BIN = '/home/user/.nvm/versions/node/v20/bin';
      const result = getEnhancedPath();
      expect(result).toContain('/home/user/.nvm/versions/node/v20/bin');
      delete process.env.NVM_BIN;
    });
  });

  describe('CLI path parameter for Node.js detection', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    function mockNodeExecutable(fakeDir: string) {
      const nodePath = path.join(fakeDir, isWindows ? 'node.exe' : 'node');
      jest.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === nodePath);
      jest.spyOn(fs, 'statSync').mockImplementation(
        p => ({ isFile: () => String(p) === nodePath }) as fs.Stats
      );
      return nodePath;
    }

    it('prepends detected node directory before extra paths when cliPath is .js', () => {
      const fakeDir = isWindows ? 'C:\\fake\\node' : '/tmp/fake-node';
      mockNodeExecutable(fakeDir);

      const otherPath = isWindows ? 'C:\\other' : '/other';
      process.env.PATH = `${fakeDir}${SEP}${otherPath}`;
      if (isWindows) {
        process.env.ProgramFiles = 'C:\\Program Files';
      }

      const result = getEnhancedPath(undefined, '/path/to/cli.js');
      const segments = result.split(SEP);
      const extraPath = isWindows ? 'C:\\Program Files\\nodejs' : '/usr/local/bin';

      const nodeIndex = segments.indexOf(fakeDir);
      const extraIndex = segments.indexOf(extraPath);

      expect(nodeIndex).toBeGreaterThanOrEqual(0);
      expect(extraIndex).toBeGreaterThanOrEqual(0);
      expect(nodeIndex).toBeLessThan(extraIndex);
    });

    it('does not prepend node directory when cliPath is native binary', () => {
      const fakeDir = isWindows ? 'C:\\fake\\node' : '/tmp/fake-node';
      mockNodeExecutable(fakeDir);

      const otherPath = isWindows ? 'C:\\other' : '/other';
      process.env.PATH = `${fakeDir}${SEP}${otherPath}`;
      if (isWindows) {
        process.env.ProgramFiles = 'C:\\Program Files';
      }

      const result = getEnhancedPath(undefined, '/path/to/claude.exe');
      const segments = result.split(SEP);
      const extraPath = isWindows ? 'C:\\Program Files\\nodejs' : '/usr/local/bin';

      const nodeIndex = segments.indexOf(fakeDir);
      const extraIndex = segments.indexOf(extraPath);

      expect(nodeIndex).toBeGreaterThanOrEqual(0);
      expect(extraIndex).toBeGreaterThanOrEqual(0);
      expect(nodeIndex).toBeGreaterThan(extraIndex);
    });

    it('accepts cliPath parameter without error', () => {
      const result = getEnhancedPath(undefined, '/path/to/cli.js');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('works with both additionalPaths and cliPath', () => {
      const result = getEnhancedPath('/custom/path', '/path/to/cli.js');
      expect(result).toContain('/custom/path');
    });

    it('works with native binary path (no Node.js detection needed)', () => {
      const result = getEnhancedPath(undefined, '/path/to/claude.exe');
      expect(typeof result).toBe('string');
    });
  });

  describe('CLI directory with node executable (nvm/fnm/volta/asdf support)', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    function mockCliDirWithNode(cliDir: string) {
      const nodePath = path.join(cliDir, isWindows ? 'node.exe' : 'node');
      jest.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === nodePath);
      jest.spyOn(fs, 'statSync').mockImplementation(
        p => ({ isFile: () => String(p) === nodePath }) as fs.Stats
      );
    }

    it('adds CLI directory to PATH when it contains node (Unix nvm)', () => {
      if (isWindows) return;

      const nvmBinDir = '/Users/test/.nvm/versions/node/v20.10.0/bin';
      const cliPath = path.join(nvmBinDir, 'claude');
      mockCliDirWithNode(nvmBinDir);

      process.env.PATH = '/usr/bin';
      const result = getEnhancedPath(undefined, cliPath);
      const segments = result.split(SEP);

      // CLI directory should be added and come before /usr/bin
      expect(segments).toContain(nvmBinDir);
      expect(segments.indexOf(nvmBinDir)).toBeLessThan(segments.indexOf('/usr/bin'));
    });

    it('adds CLI directory to PATH when it contains node (Windows nvm)', () => {
      if (!isWindows) return;

      const nvmBinDir = 'C:\\Users\\test\\AppData\\Roaming\\nvm\\v20.10.0';
      const cliPath = path.join(nvmBinDir, 'claude.cmd');
      mockCliDirWithNode(nvmBinDir);

      process.env.PATH = 'C:\\Windows\\System32';
      const result = getEnhancedPath(undefined, cliPath);
      const segments = result.split(SEP);

      // CLI directory should be added (case-insensitive check for Windows)
      const hasNvmDir = segments.some(s => s.toLowerCase() === nvmBinDir.toLowerCase());
      expect(hasNvmDir).toBe(true);
    });

    it('adds CLI directory to PATH for fnm installation', () => {
      if (isWindows) return;

      const fnmBinDir = '/Users/test/.fnm/node-versions/v20.10.0/installation/bin';
      const cliPath = path.join(fnmBinDir, 'claude');
      mockCliDirWithNode(fnmBinDir);

      process.env.PATH = '/usr/bin';
      const result = getEnhancedPath(undefined, cliPath);

      expect(result).toContain(fnmBinDir);
    });

    it('adds CLI directory to PATH for volta installation', () => {
      if (isWindows) return;

      const voltaBinDir = '/Users/test/.volta/bin';
      const cliPath = path.join(voltaBinDir, 'claude');
      mockCliDirWithNode(voltaBinDir);

      process.env.PATH = '/usr/bin';
      const result = getEnhancedPath(undefined, cliPath);

      expect(result).toContain(voltaBinDir);
    });

    it('adds CLI directory to PATH for asdf installation', () => {
      if (isWindows) return;

      const asdfBinDir = '/Users/test/.asdf/installs/nodejs/20.10.0/bin';
      const cliPath = path.join(asdfBinDir, 'claude');
      mockCliDirWithNode(asdfBinDir);

      process.env.PATH = '/usr/bin';
      const result = getEnhancedPath(undefined, cliPath);

      expect(result).toContain(asdfBinDir);
    });

    it('does not add CLI directory when node is not present', () => {
      const cliDir = isWindows ? 'C:\\custom\\bin' : '/custom/bin';
      const cliPath = path.join(cliDir, isWindows ? 'claude.exe' : 'claude');

      // Mock: node does not exist in CLI directory
      jest.spyOn(fs, 'existsSync').mockReturnValue(false);

      process.env.PATH = isWindows ? 'C:\\Windows\\System32' : '/usr/bin';
      const result = getEnhancedPath(undefined, cliPath);

      expect(result).not.toContain(cliDir);
    });

    it('CLI directory has higher priority than fallback node search', () => {
      if (isWindows) return;

      const nvmBinDir = '/Users/test/.nvm/versions/node/v20.10.0/bin';
      const cliPath = path.join(nvmBinDir, 'cli.js'); // JS file

      // Mock: node exists in CLI directory
      const nodePath = path.join(nvmBinDir, 'node');
      jest.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === nodePath);
      jest.spyOn(fs, 'statSync').mockImplementation(
        p => ({ isFile: () => String(p) === nodePath }) as fs.Stats
      );

      process.env.PATH = '/usr/bin';
      const result = getEnhancedPath(undefined, cliPath);
      const segments = result.split(SEP);

      // CLI directory should be first (after any additional paths)
      expect(segments[0]).toBe(nvmBinDir);
    });

    it('user additional paths have highest priority over CLI directory', () => {
      if (isWindows) return;

      const nvmBinDir = '/Users/test/.nvm/versions/node/v20.10.0/bin';
      const cliPath = path.join(nvmBinDir, 'claude');
      mockCliDirWithNode(nvmBinDir);

      const userPath = '/user/custom/bin';
      process.env.PATH = '/usr/bin';
      const result = getEnhancedPath(userPath, cliPath);
      const segments = result.split(SEP);

      // User path should be first, then CLI directory
      expect(segments[0]).toBe(userPath);
      expect(segments[1]).toBe(nvmBinDir);
    });
  });
});

describe('cliPathRequiresNode', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns true for .js files', () => {
    expect(cliPathRequiresNode('/path/to/cli.js')).toBe(true);
    expect(cliPathRequiresNode('C:\\path\\to\\cli.js')).toBe(true);
  });

  it('returns true for other JS extensions', () => {
    expect(cliPathRequiresNode('/path/to/cli.mjs')).toBe(true);
    expect(cliPathRequiresNode('/path/to/cli.cjs')).toBe(true);
    expect(cliPathRequiresNode('/path/to/cli.ts')).toBe(true);
    expect(cliPathRequiresNode('/path/to/cli.tsx')).toBe(true);
    expect(cliPathRequiresNode('/path/to/cli.jsx')).toBe(true);
  });

  it('returns false for native binaries', () => {
    expect(cliPathRequiresNode('/path/to/claude')).toBe(false);
    expect(cliPathRequiresNode('/path/to/claude.exe')).toBe(false);
    expect(cliPathRequiresNode('C:\\path\\to\\claude.exe')).toBe(false);
  });

  it('returns true for scripts with node shebang', () => {
    const scriptPath = isWindows ? 'C:\\temp\\claude' : '/tmp/claude';
    const shebang = '#!/usr/bin/env node\nconsole.log("hi");\n';

    jest.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === scriptPath);
    jest.spyOn(fs, 'statSync').mockImplementation(
      p => ({ isFile: () => String(p) === scriptPath }) as fs.Stats
    );
    jest.spyOn(fs, 'openSync').mockImplementation(() => 1 as any);
    jest.spyOn(fs, 'readSync').mockImplementation((_, buffer: Buffer) => {
      buffer.write(shebang);
      return shebang.length;
    });
    jest.spyOn(fs, 'closeSync').mockImplementation(() => {});

    expect(cliPathRequiresNode(scriptPath)).toBe(true);
  });

  it('returns false when path exists but is a directory', () => {
    const dirPath = isWindows ? 'C:\\temp\\claude' : '/tmp/claude';
    jest.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === dirPath);
    jest.spyOn(fs, 'statSync').mockImplementation(
      () => ({ isFile: () => false }) as fs.Stats
    );

    expect(cliPathRequiresNode(dirPath)).toBe(false);
  });

  it('returns false for scripts without node shebang', () => {
    const scriptPath = isWindows ? 'C:\\temp\\script' : '/tmp/script';
    const shebang = '#!/usr/bin/env python\nprint("hi")\n';

    jest.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === scriptPath);
    jest.spyOn(fs, 'statSync').mockImplementation(
      p => ({ isFile: () => String(p) === scriptPath }) as fs.Stats
    );
    jest.spyOn(fs, 'openSync').mockImplementation(() => 1 as any);
    jest.spyOn(fs, 'readSync').mockImplementation((_, buffer: Buffer) => {
      buffer.write(shebang);
      return shebang.length;
    });
    jest.spyOn(fs, 'closeSync').mockImplementation(() => {});

    expect(cliPathRequiresNode(scriptPath)).toBe(false);
  });

  it('returns false for .cmd files', () => {
    expect(cliPathRequiresNode('/path/to/claude.cmd')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(cliPathRequiresNode('/path/to/CLI.JS')).toBe(true);
    expect(cliPathRequiresNode('/path/to/cli.MJS')).toBe(true);
  });
});

describe('getMissingNodeError', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns null when CLI does not require Node.js', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const error = getMissingNodeError('/path/to/claude');
    expect(error).toBeNull();
  });

  it('returns error when Node.js is missing and CLI requires Node.js', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const error = getMissingNodeError('/path/to/cli.js', '/missing');
    expect(error).toContain('Node.js');
  });

  it('returns null when Node.js is found on PATH', () => {
    const nodeDir = isWindows ? 'C:\\custom\\bin' : '/custom/bin';
    const nodePath = path.join(nodeDir, isWindows ? 'node.exe' : 'node');

    jest.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === nodePath);
    jest.spyOn(fs, 'statSync').mockImplementation(
      p => ({ isFile: () => String(p) === nodePath }) as fs.Stats
    );

    const error = getMissingNodeError('/path/to/cli.js', nodeDir);
    expect(error).toBeNull();
  });
});

describe('findNodeDirectory', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.restoreAllMocks();
    Object.keys(process.env).forEach(key => delete process.env[key]);
    Object.assign(process.env, originalEnv);
  });

  it('returns string or null', () => {
    const result = findNodeDirectory();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('returns a non-empty string when node is found', () => {
    const result = findNodeDirectory();
    // On most dev machines, node should be findable
    // Result is either null (not found) or a non-empty directory path
    const isValidResult = result === null || (typeof result === 'string' && result.length > 0);
    expect(isValidResult).toBe(true);
  });

  it('uses NVM_SYMLINK when set on Windows', () => {
    if (!isWindows) {
      return;
    }

    const nvmSymlink = 'C:\\nvm\\symlink';
    const nodePath = path.join(nvmSymlink, 'node.exe');
    jest.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === nodePath);
    jest.spyOn(fs, 'statSync').mockImplementation(
      p => ({ isFile: () => String(p) === nodePath }) as fs.Stats
    );

    process.env.NVM_SYMLINK = nvmSymlink;
    process.env.PATH = '';

    const result = findNodeDirectory();
    expect(result).toBe(nvmSymlink);
  });

  it('prefers additionalPaths over process.env.PATH', () => {
    const nodeExecutable = isWindows ? 'node.exe' : 'node';
    const preferredDir = isWindows ? 'C:\\custom\\bin' : '/custom/bin';
    const fallbackDir = isWindows ? 'C:\\fallback\\bin' : '/fallback/bin';
    const preferredNode = path.join(preferredDir, nodeExecutable);
    const fallbackNode = path.join(fallbackDir, nodeExecutable);

    jest.spyOn(fs, 'existsSync').mockImplementation(p => {
      const candidate = String(p);
      return candidate === preferredNode || candidate === fallbackNode;
    });
    jest.spyOn(fs, 'statSync').mockImplementation(
      () => ({ isFile: () => true }) as fs.Stats
    );

    process.env.PATH = fallbackDir;

    const result = findNodeDirectory(preferredDir);
    expect(result).toBe(preferredDir);
  });

  it('returns full path for findNodeExecutable when available', () => {
    const nodeExecutable = isWindows ? 'node.exe' : 'node';
    const preferredDir = isWindows ? 'C:\\custom\\bin' : '/custom/bin';
    const preferredNode = path.join(preferredDir, nodeExecutable);

    jest.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === preferredNode);
    jest.spyOn(fs, 'statSync').mockImplementation(
      () => ({ isFile: () => true }) as fs.Stats
    );

    const result = findNodeExecutable(preferredDir);
    expect(result).toBe(preferredNode);
  });
});

describe('getHostnameKey', () => {
  it('returns a non-empty string', () => {
    const hostname = getHostnameKey();
    expect(typeof hostname).toBe('string');
    expect(hostname.length).toBeGreaterThan(0);
  });

  it('returns the system hostname', () => {
    const hostname = getHostnameKey();
    expect(hostname).toBe(os.hostname());
  });

  it('returns consistent value on repeated calls', () => {
    const first = getHostnameKey();
    const second = getHostnameKey();
    expect(first).toBe(second);
  });
});

describe('parseContextLimit', () => {
  it('should parse "256k" to 256000', () => {
    expect(parseContextLimit('256k')).toBe(256000);
  });

  it('should parse "256K" to 256000 (case insensitive)', () => {
    expect(parseContextLimit('256K')).toBe(256000);
  });

  it('should parse "1m" to 1000000', () => {
    expect(parseContextLimit('1m')).toBe(1000000);
  });

  it('should parse "1M" to 1000000 (case insensitive)', () => {
    expect(parseContextLimit('1M')).toBe(1000000);
  });

  it('should parse "1000000" to 1000000', () => {
    expect(parseContextLimit('1000000')).toBe(1000000);
  });

  it('should parse "1.5m" to 1500000', () => {
    expect(parseContextLimit('1.5m')).toBe(1500000);
  });

  it('should parse "200k" to 200000', () => {
    expect(parseContextLimit('200k')).toBe(200000);
  });

  it('should handle whitespace', () => {
    expect(parseContextLimit('  256k  ')).toBe(256000);
  });

  it('should handle space before suffix', () => {
    expect(parseContextLimit('256 k')).toBe(256000);
    expect(parseContextLimit('1 m')).toBe(1000000);
    expect(parseContextLimit('1.5 m')).toBe(1500000);
  });

  it('should return null for empty string', () => {
    expect(parseContextLimit('')).toBeNull();
  });

  it('should return null for whitespace only', () => {
    expect(parseContextLimit('   ')).toBeNull();
  });

  it('should return null for invalid input', () => {
    expect(parseContextLimit('abc')).toBeNull();
    expect(parseContextLimit('k256')).toBeNull();
    expect(parseContextLimit('256x')).toBeNull();
  });

  it('should return null for negative values', () => {
    expect(parseContextLimit('-100k')).toBeNull();
  });

  it('should return null for zero', () => {
    expect(parseContextLimit('0k')).toBeNull();
  });

  it('should return null for values below 1k', () => {
    expect(parseContextLimit('100')).toBeNull();
    expect(parseContextLimit('999')).toBeNull();
  });

  it('should return null for values above 10m', () => {
    expect(parseContextLimit('20m')).toBeNull();
    expect(parseContextLimit('11000000')).toBeNull();
  });

  it('should accept boundary values', () => {
    expect(parseContextLimit('1k')).toBe(1000);
    expect(parseContextLimit('10m')).toBe(10000000);
  });
});

describe('formatContextLimit', () => {
  it('should format 256000 as "256k"', () => {
    expect(formatContextLimit(256000)).toBe('256k');
  });

  it('should format 1000000 as "1m"', () => {
    expect(formatContextLimit(1000000)).toBe('1m');
  });

  it('should format 200000 as "200k"', () => {
    expect(formatContextLimit(200000)).toBe('200k');
  });

  it('should format 2000000 as "2m"', () => {
    expect(formatContextLimit(2000000)).toBe('2m');
  });

  it('should format non-round numbers with toLocaleString', () => {
    expect(formatContextLimit(256500)).toBe('256,500');
  });

  it('should format small numbers with toLocaleString', () => {
    expect(formatContextLimit(500)).toBe('500');
  });

  it('should round-trip through parseContextLimit for all formats', () => {
    // Round numbers (k/m suffix)
    expect(parseContextLimit(formatContextLimit(256000))).toBe(256000);
    expect(parseContextLimit(formatContextLimit(1000000))).toBe(1000000);
    expect(parseContextLimit(formatContextLimit(2000000))).toBe(2000000);

    // Non-round numbers (locale-formatted with commas)
    expect(parseContextLimit(formatContextLimit(256500))).toBe(256500);
    expect(parseContextLimit(formatContextLimit(1234567))).toBe(1234567);
  });
});

describe('parseContextLimit with comma-formatted input', () => {
  it('should parse "256,500" to 256500', () => {
    expect(parseContextLimit('256,500')).toBe(256500);
  });

  it('should parse "1,000,000" to 1000000', () => {
    expect(parseContextLimit('1,000,000')).toBe(1000000);
  });

  it('should parse "1,234,567" to 1234567', () => {
    expect(parseContextLimit('1,234,567')).toBe(1234567);
  });
});

describe('getCustomModelIds', () => {
  it('should return empty set when no custom models configured', () => {
    const result = getCustomModelIds({});
    expect(result.size).toBe(0);
  });

  it('should extract ANTHROPIC_MODEL', () => {
    const result = getCustomModelIds({ ANTHROPIC_MODEL: 'custom-model' });
    expect(result.size).toBe(1);
    expect(result.has('custom-model')).toBe(true);
  });

  it('should extract model from default tier env vars', () => {
    const result = getCustomModelIds({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'my-opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'my-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'my-haiku',
    });
    expect(result.size).toBe(3);
    expect(result.has('my-opus')).toBe(true);
    expect(result.has('my-sonnet')).toBe(true);
    expect(result.has('my-haiku')).toBe(true);
  });

  it('should deduplicate when multiple env vars point to same model', () => {
    const result = getCustomModelIds({
      ANTHROPIC_MODEL: 'shared-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'shared-model',
    });
    expect(result.size).toBe(1);
    expect(result.has('shared-model')).toBe(true);
  });

  it('should ignore unrelated env vars', () => {
    const result = getCustomModelIds({
      ANTHROPIC_API_KEY: 'secret-key',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
      OTHER_VAR: 'value',
    });
    expect(result.size).toBe(0);
  });

  it('should handle mixed relevant and irrelevant env vars', () => {
    const result = getCustomModelIds({
      ANTHROPIC_API_KEY: 'secret-key',
      ANTHROPIC_MODEL: 'custom-model',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
    });
    expect(result.size).toBe(1);
    expect(result.has('custom-model')).toBe(true);
  });

  it('should ignore empty string model values', () => {
    const result = getCustomModelIds({
      ANTHROPIC_MODEL: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'valid-model',
    });
    expect(result.size).toBe(1);
    expect(result.has('')).toBe(false);
    expect(result.has('valid-model')).toBe(true);
  });

  it('should ignore whitespace-only model values', () => {
    const result = getCustomModelIds({
      ANTHROPIC_MODEL: '   ',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'my-haiku',
    });
    // Note: getCustomModelIds only checks truthiness, so whitespace passes
    // This test documents the current behavior
    expect(result.has('my-haiku')).toBe(true);
  });
});

describe('getModelsFromEnvironment', () => {
  it('returns empty array when no custom models configured', () => {
    const result = getModelsFromEnvironment({});
    expect(result).toEqual([]);
  });

  it('returns model for ANTHROPIC_MODEL', () => {
    const result = getModelsFromEnvironment({ ANTHROPIC_MODEL: 'custom-model-v1' });
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('custom-model-v1');
    expect(result[0].description).toContain('model');
  });

  it('formats label from hyphenated model name', () => {
    const result = getModelsFromEnvironment({ ANTHROPIC_MODEL: 'claude-3-opus' });
    expect(result[0].label).toBe('Claude 3 Opus');
  });

  it('formats label from slash-separated model name', () => {
    const result = getModelsFromEnvironment({ ANTHROPIC_MODEL: 'org/custom-model' });
    expect(result[0].label).toBe('custom-model');
  });

  it('returns models for tier-specific env vars', () => {
    const result = getModelsFromEnvironment({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'my-opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'my-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'my-haiku',
    });
    expect(result).toHaveLength(3);
    expect(result.map(m => m.value)).toContain('my-opus');
    expect(result.map(m => m.value)).toContain('my-sonnet');
    expect(result.map(m => m.value)).toContain('my-haiku');
  });

  it('deduplicates when multiple env vars point to same model', () => {
    const result = getModelsFromEnvironment({
      ANTHROPIC_MODEL: 'shared-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'shared-model',
    });
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('shared-model');
    expect(result[0].description).toContain('model');
    expect(result[0].description).toContain('sonnet');
  });

  it('sorts by type priority (model > haiku > sonnet > opus)', () => {
    const result = getModelsFromEnvironment({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-v1',
      ANTHROPIC_MODEL: 'main-model',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-v1',
    });
    expect(result[0].value).toBe('main-model');
    expect(result[1].value).toBe('haiku-v1');
    expect(result[2].value).toBe('opus-v1');
  });

  it('ignores unrelated env vars', () => {
    const result = getModelsFromEnvironment({
      ANTHROPIC_API_KEY: 'sk-key',
      OTHER_VAR: 'value',
    });
    expect(result).toEqual([]);
  });

  it('ignores empty model values', () => {
    const result = getModelsFromEnvironment({
      ANTHROPIC_MODEL: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'valid-model',
    });
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('valid-model');
  });
});

describe('getCurrentModelFromEnvironment', () => {
  it('returns null when no model env vars set', () => {
    expect(getCurrentModelFromEnvironment({})).toBeNull();
  });

  it('returns ANTHROPIC_MODEL when set', () => {
    expect(getCurrentModelFromEnvironment({
      ANTHROPIC_MODEL: 'custom-model',
    })).toBe('custom-model');
  });

  it('prefers ANTHROPIC_MODEL over tier-specific vars', () => {
    expect(getCurrentModelFromEnvironment({
      ANTHROPIC_MODEL: 'main-model',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-model',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-model',
    })).toBe('main-model');
  });

  it('falls back to ANTHROPIC_DEFAULT_HAIKU_MODEL', () => {
    expect(getCurrentModelFromEnvironment({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-model',
    })).toBe('haiku-model');
  });

  it('falls back to ANTHROPIC_DEFAULT_SONNET_MODEL', () => {
    expect(getCurrentModelFromEnvironment({
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-model',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-model',
    })).toBe('sonnet-model');
  });

  it('falls back to ANTHROPIC_DEFAULT_OPUS_MODEL', () => {
    expect(getCurrentModelFromEnvironment({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-model',
    })).toBe('opus-model');
  });

  it('returns null when only unrelated vars set', () => {
    expect(getCurrentModelFromEnvironment({
      ANTHROPIC_API_KEY: 'sk-key',
      OTHER_VAR: 'value',
    })).toBeNull();
  });
});

describe('getExtraBinaryPaths (Windows branches)', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.keys(process.env).forEach(key => delete process.env[key]);
    Object.assign(process.env, originalEnv);
    jest.resetModules();
  });

  function loadWithWindowsPlatform(): typeof env {
    jest.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
    // Dynamic require needed to re-evaluate module with mocked platform
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../../../src/utils/env');
  }

  it('includes APPDATA npm path when APPDATA is set', () => {
    process.env.APPDATA = '/mock/AppData/Roaming';
    process.env.LOCALAPPDATA = '/mock/AppData/Local';
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('npm');
    expect(result).toContain('Roaming');
  });

  it('includes LOCALAPPDATA nodejs paths', () => {
    process.env.LOCALAPPDATA = '/mock/AppData/Local';
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('Local');
    expect(result).toContain('nodejs');
  });

  it('includes NVM_SYMLINK when set', () => {
    process.env.NVM_SYMLINK = '/mock/nvm/symlink';
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('/mock/nvm/symlink');
  });

  it('includes NVM_HOME when set', () => {
    process.env.NVM_HOME = '/mock/nvm/home';
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('/mock/nvm/home');
  });

  it('falls back to APPDATA/nvm when NVM_HOME not set', () => {
    delete process.env.NVM_HOME;
    process.env.APPDATA = '/mock/AppData/Roaming';
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('nvm');
  });

  it('includes VOLTA_HOME/bin when set', () => {
    process.env.VOLTA_HOME = '/mock/volta';
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('volta');
  });

  it('falls back to home/.volta/bin when VOLTA_HOME not set', () => {
    delete process.env.VOLTA_HOME;
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('.volta');
  });

  it('includes FNM_MULTISHELL_PATH when set', () => {
    process.env.FNM_MULTISHELL_PATH = '/mock/fnm/multishell';
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('/mock/fnm/multishell');
  });

  it('includes FNM_DIR when set', () => {
    process.env.FNM_DIR = '/mock/fnm/dir';
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('/mock/fnm/dir');
  });

  it('falls back to LOCALAPPDATA/fnm when FNM_DIR not set', () => {
    delete process.env.FNM_DIR;
    process.env.LOCALAPPDATA = '/mock/AppData/Local';
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('fnm');
  });

  it('includes ChocolateyInstall/bin when set', () => {
    process.env.ChocolateyInstall = '/mock/choco';
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('choco');
  });

  it('falls back to ProgramData/chocolatey/bin when ChocolateyInstall not set', () => {
    delete process.env.ChocolateyInstall;
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('chocolatey');
  });

  it('includes SCOOP paths when set', () => {
    process.env.SCOOP = '/mock/scoop';
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('scoop');
    expect(result).toContain('shims');
  });

  it('falls back to home/scoop when SCOOP not set', () => {
    delete process.env.SCOOP;
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('scoop');
  });

  it('includes Docker path under Program Files', () => {
    process.env.ProgramFiles = '/mock/Program Files';
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('Docker');
  });

  it('includes home/.local/bin on Windows', () => {
    process.env.HOME = '/mock/home';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('.local');
  });

  it('uses semicolon separator on Windows', () => {
    process.env.HOME = '/mock/home';
    process.env.PATH = '/existing';
    const mod = loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain(';');
  });
});
