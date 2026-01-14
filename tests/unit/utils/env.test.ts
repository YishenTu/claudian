/**
 * Tests for environment utilities.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as env from '../../../src/utils/env';

const { cliPathRequiresNode, findNodeDirectory, getEnhancedPath, getHostnameKey, parseEnvironmentVariables } = env;

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

  it('returns false for .cmd files', () => {
    expect(cliPathRequiresNode('/path/to/claude.cmd')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(cliPathRequiresNode('/path/to/CLI.JS')).toBe(true);
    expect(cliPathRequiresNode('/path/to/cli.MJS')).toBe(true);
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
