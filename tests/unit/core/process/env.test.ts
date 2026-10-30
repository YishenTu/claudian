// @test-ci {"native":true}
const actualModule0 = await import('fs');
const actualModule1 = await import('path');
import type * as fsType from 'fs';
import { runInNewContext } from 'vm';

const fs = actualModule0;
const path = actualModule1;

import { parsePathEntries } from '@/core/process/cliPath';
import * as env from '@/core/process/env';


const {
  cliPathRequiresNode,
  findNodeDirectory,
  findNodeExecutable,
  findNodeExecutables,
  getEnhancedPath,
  parseEnvironmentVariables,
} = env;

const isWindows = process.platform === 'win32';
const SEP = isWindows ? ';' : ':';

/** Narrow `fs.accessSync` boundary: listed candidates are executable, all others fail admission. */
function mockExecuteAccess(...runnablePaths: string[]): void {
  vi.spyOn(fs, 'accessSync').mockImplementation(((p: fsType.PathLike) => {
    if (runnablePaths.includes(String(p))) return;
    throw Object.assign(new Error(`EACCES: permission denied, access '${String(p)}'`), { code: 'EACCES' });
  }) as typeof fs.accessSync);
}

describe('parseEnvironmentVariables', () => {
  it.each([
    ['__proto__=literal', 'literal'],
    ['__proto__="quoted value"', 'quoted value'],
    ["export __proto__='exported value'", 'exported value'],
    ['__proto__=first\n__proto__=last', 'last'],
    ['__proto__=first\n__proto__=', ''],
  ])('retains an own environment entry for %s', (input, value) => {
    const result = parseEnvironmentVariables(input);

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')).toEqual({
      value, enumerable: true, writable: true, configurable: true,
    });
    expect(Object.keys(result)).toEqual(['__proto__']);
    // Keep native spread semantics for the prototype-sensitive assertion.
    const spread = runInNewContext('({ ...environment })', { environment: result });
    expect(Object.keys(spread)).toEqual(['__proto__']);
    expect(spread['__proto__']).toBe(value);
    const roundTrip = JSON.parse(JSON.stringify(result));
    expect(Object.keys(roundTrip)).toEqual(['__proto__']);
    expect(roundTrip['__proto__']).toBe(value);
  });

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
    it('includes the default OpenCode install bin path from HOME', () => {
      process.env.HOME = '/mock/home';
      const result = getEnhancedPath();
      const segments = result.split(SEP);

      expect(segments).toContain(path.join('/mock/home', '.opencode', 'bin'));
    });

    it('includes the user bin path from HOME', () => {
      process.env.HOME = '/mock/home';
      const result = getEnhancedPath();
      const segments = result.split(SEP);

      expect(segments).toContain(path.join('/mock/home', 'bin'));
    });
  });

  describe.skipIf(isWindows)('Unix environment variable paths', () => {
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

    describe.skipIf(isWindows)('fnm aliases (Unix)', () => {
      it('includes default Node.js bins without the fnm shell hook', () => {
        delete process.env.XDG_DATA_HOME;
        process.env.FNM_DIR = '/custom/fnm';
        process.env.HOME = '/fake/home';
        const entries = parsePathEntries(getEnhancedPath());
        expect(entries).toEqual(expect.arrayContaining([
          '/custom/fnm/aliases/default/bin',
          '/fake/home/.local/share/fnm/aliases/default/bin',
          '/fake/home/.fnm/aliases/default/bin',
          ...(process.platform === 'darwin' ? ['/fake/home/Library/Application Support/fnm/aliases/default/bin'] : []),
        ]));
      });
    });

    describe.skipIf(isWindows)('other Node.js and CLI managers (Unix)', () => {
      const managerVariables = ['NODENV_ROOT', 'PROTO_HOME', 'PNPM_HOME', 'N_PREFIX', 'NVS_HOME', 'XDG_DATA_HOME'];

      it('includes default locations without shell variables', () => {
        for (const key of managerVariables) delete process.env[key];
        process.env.HOME = '/fake/home';
        const entries = parsePathEntries(getEnhancedPath());
        expect(entries).toEqual(expect.arrayContaining([
          '/fake/home/.local/share/pi-node/current/bin',
          '/fake/home/.nodenv/shims',
          '/fake/home/.proto/shims',
          '/fake/home/.proto/bin',
          '/fake/home/.local/share/pnpm',
          '/fake/home/.nvs/default/bin',
          '/fake/home/.nix-profile/bin',
          '/nix/var/nix/profiles/default/bin',
          '/run/current-system/sw/bin',
          '/opt/local/bin',
          '/home/linuxbrew/.linuxbrew/bin',
          ...(process.platform === 'darwin' ? ['/fake/home/Library/pnpm'] : []),
        ]));
      });

      it('follows manager home variables', () => {
        process.env.HOME = '/fake/home';
        process.env.XDG_DATA_HOME = '/xdg';
        process.env.NODENV_ROOT = '/custom/nodenv';
        process.env.PROTO_HOME = '/custom/proto';
        process.env.PNPM_HOME = '/custom/pnpm';
        process.env.N_PREFIX = '/custom/n';
        process.env.NVS_HOME = '/custom/nvs';
        const entries = parsePathEntries(getEnhancedPath());
        expect(entries).toEqual(expect.arrayContaining([
          '/xdg/pi-node/current/bin',
          '/xdg/pnpm',
          '/custom/nodenv/shims',
          '/custom/proto/shims',
          '/custom/proto/bin',
          '/custom/pnpm',
          '/custom/n/bin',
          '/custom/nvs/default/bin',
        ]));
        expect(entries).not.toContain('/fake/home/.nodenv/shims');
      });
    });

    it('includes NVM_BIN when set', () => {
      process.env.NVM_BIN = '/home/user/.nvm/versions/node/v20/bin';
      const result = getEnhancedPath();
      expect(result).toContain('/home/user/.nvm/versions/node/v20/bin');
      delete process.env.NVM_BIN;
    });

    describe.skipIf(isWindows)('nvm fallback when NVM_BIN is not set (Unix)', () => {
      let savedNvmBin: string | undefined;
      let savedNvmDir: string | undefined;
      let savedHome: string | undefined;

      beforeEach(() => {
        savedNvmBin = process.env.NVM_BIN;
        savedNvmDir = process.env.NVM_DIR;
        savedHome = process.env.HOME;
        delete process.env.NVM_BIN;
        delete process.env.NVM_DIR;
        process.env.HOME = '/fake/home';
      });

      afterEach(() => {
        vi.restoreAllMocks();
        if (savedNvmBin !== undefined) process.env.NVM_BIN = savedNvmBin;
        else delete process.env.NVM_BIN;
        if (savedNvmDir !== undefined) process.env.NVM_DIR = savedNvmDir;
        else delete process.env.NVM_DIR;
        if (savedHome !== undefined) process.env.HOME = savedHome;
        else delete process.env.HOME;
      });

      function mockNvm(opts: {
        nvmDir: string;
        aliasFiles: Record<string, string>;
        versions: string[];
        existingBinDirs?: string[];
      }) {
        const { nvmDir, aliasFiles, versions, existingBinDirs } = opts;
        const binDirs = existingBinDirs ?? versions.map(v => path.join(nvmDir, 'versions', 'node', v, 'bin'));

        vi.spyOn(fs, 'existsSync').mockImplementation(p => binDirs.includes(String(p)));
        vi.spyOn(fs, 'readFileSync').mockImplementation(((p: string) => {
          const s = String(p);
          for (const [aliasPath, value] of Object.entries(aliasFiles)) {
            if (s === aliasPath) return value;
          }
          throw new Error('not found');
        }) as typeof fs.readFileSync);
        vi.spyOn(fs, 'readdirSync').mockImplementation(((p: string) => {
          if (String(p) === path.join(nvmDir, 'versions', 'node')) return versions;
          return [];
        }) as typeof fs.readdirSync);
        vi.spyOn(fs, 'statSync').mockImplementation(
          () => ({ isFile: () => true, isDirectory: () => true }) as fsType.Stats
        );
      }

      it('resolves default version from alias file', () => {
        const nvmDir = '/fake/home/.nvm';
        const versionBin = path.join(nvmDir, 'versions', 'node', 'v22.18.0', 'bin');
        mockNvm({
          nvmDir,
          aliasFiles: { [path.join(nvmDir, 'alias', 'default')]: '22' },
          versions: ['v22.18.0'],
        });

        expect(getEnhancedPath()).toContain(versionBin);
      });

      it('respects NVM_DIR env var', () => {
        process.env.NVM_DIR = '/custom/nvm';
        const versionBin = '/custom/nvm/versions/node/v20.10.0/bin';
        mockNvm({
          nvmDir: '/custom/nvm',
          aliasFiles: { '/custom/nvm/alias/default': '20' },
          versions: ['v20.10.0'],
        });

        expect(getEnhancedPath()).toContain(versionBin);
      });

      it('picks highest matching version when multiple match', () => {
        const nvmDir = '/fake/home/.nvm';
        const expectedBin = path.join(nvmDir, 'versions', 'node', 'v22.18.0', 'bin');
        mockNvm({
          nvmDir,
          aliasFiles: { [path.join(nvmDir, 'alias', 'default')]: '22' },
          versions: ['v22.5.0', 'v22.18.0', 'v20.10.0'],
        });

        const result = getEnhancedPath();
        expect(result).toContain(expectedBin);
        expect(result).not.toContain('v22.5.0');
      });

      it('follows alias chains (lts/* → lts/jod → version)', () => {
        const nvmDir = '/fake/home/.nvm';
        const versionBin = path.join(nvmDir, 'versions', 'node', 'v22.18.0', 'bin');
        mockNvm({
          nvmDir,
          aliasFiles: {
            [path.join(nvmDir, 'alias', 'default')]: 'lts/*',
            [path.join(nvmDir, 'alias', 'lts', '*')]: 'lts/jod',
            [path.join(nvmDir, 'alias', 'lts', 'jod')]: 'v22.18.0',
          },
          versions: ['v22.18.0', 'v20.10.0'],
        });

        expect(getEnhancedPath()).toContain(versionBin);
      });

      it.each(['node', 'stable'])(
        'resolves built-in %s alias to the highest installed version',
        builtInAlias => {
          const nvmDir = '/fake/home/.nvm';
          const expectedBin = path.join(nvmDir, 'versions', 'node', 'v22.18.0', 'bin');
          mockNvm({
            nvmDir,
            aliasFiles: {
              [path.join(nvmDir, 'alias', 'default')]: builtInAlias,
            },
            versions: ['v20.10.0', 'v22.18.0'],
          });

          const result = getEnhancedPath();
          expect(result).toContain(expectedBin);
          expect(result).not.toContain('v20.10.0');
        }
      );

      it('resolves a custom v-prefixed alias through its alias file', () => {
        delete process.env.NVM_BIN;
        process.env.NVM_DIR = '/custom/nvm';
        mockNvm({
          nvmDir: '/custom/nvm',
          aliasFiles: {
            '/custom/nvm/alias/default': 'vault-node',
            '/custom/nvm/alias/vault-node': 'v24.16.0',
          },
          versions: ['v24.16.0'],
        });

        const entries = parsePathEntries(getEnhancedPath());
        expect(entries).toContain('/custom/nvm/versions/node/v24.16.0/bin');
      });
    });
  });

  describe('CLI path parameter for Node.js detection', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function mockNodeExecutable(fakeDir: string) {
      const nodePath = path.join(fakeDir, isWindows ? 'node.exe' : 'node');
      vi.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === nodePath);
      vi.spyOn(fs, 'statSync').mockImplementation(
        p => ({ isFile: () => String(p) === nodePath }) as fsType.Stats
      );
      mockExecuteAccess(nodePath);
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

    it('works with both additionalPaths and cliPath', () => {
      const result = getEnhancedPath('/custom/path', '/path/to/cli.js');
      expect(result).toContain('/custom/path');
    });
  });

  describe('CLI directory with node executable (nvm/fnm/volta/asdf support)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function mockCliDirWithNode(cliDir: string) {
      const nodePath = path.join(cliDir, isWindows ? 'node.exe' : 'node');
      vi.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === nodePath);
      vi.spyOn(fs, 'statSync').mockImplementation(
        p => ({ isFile: () => String(p) === nodePath }) as fsType.Stats
      );
      mockExecuteAccess(nodePath);
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

    it('does not add CLI directory when node is not present', () => {
      const cliDir = isWindows ? 'C:\\custom\\bin' : '/custom/bin';
      const cliPath = path.join(cliDir, isWindows ? 'claude.exe' : 'claude');

      // Mock: node does not exist in CLI directory
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      process.env.PATH = isWindows ? 'C:\\Windows\\System32' : '/usr/bin';
      const result = getEnhancedPath(undefined, cliPath);

      expect(result).not.toContain(cliDir);
    });

    it('does not add a CLI directory whose sibling node lacks execute access', () => {
      if (isWindows) return;

      const cliDir = '/custom/bin';
      const cliPath = path.join(cliDir, 'cli.js');
      const nodePath = path.join(cliDir, 'node');
      vi.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === nodePath);
      vi.spyOn(fs, 'statSync').mockImplementation(
        p => ({ isFile: () => String(p) === nodePath }) as fsType.Stats
      );
      mockExecuteAccess();

      process.env.PATH = '/usr/bin';
      const result = getEnhancedPath(undefined, cliPath);
      expect(result.split(SEP)).not.toContain(cliDir);
    });

    it('CLI directory has higher priority than fallback node search', () => {
      if (isWindows) return;

      const nvmBinDir = '/Users/test/.nvm/versions/node/v20.10.0/bin';
      const cliPath = path.join(nvmBinDir, 'cli.js'); // JS file

      // Mock: node exists in CLI directory
      const nodePath = path.join(nvmBinDir, 'node');
      vi.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === nodePath);
      vi.spyOn(fs, 'statSync').mockImplementation(
        p => ({ isFile: () => String(p) === nodePath }) as fsType.Stats
      );
      mockExecuteAccess(nodePath);

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
    vi.restoreAllMocks();
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

    vi.spyOn(fs, 'openSync').mockImplementation(() => 1);
    vi.spyOn(fs, 'fstatSync').mockImplementation(
      () => ({ isFile: () => true }) as fsType.Stats
    );
    vi.spyOn(fs, 'readSync').mockImplementation((_, buffer: ArrayBufferView) => {
      Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).write(shebang);
      return shebang.length;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation(() => {});

    expect(cliPathRequiresNode(scriptPath)).toBe(true);
  });

  it('returns false when path exists but is a directory', () => {
    const dirPath = isWindows ? 'C:\\temp\\claude' : '/tmp/claude';
    vi.spyOn(fs, 'openSync').mockImplementation(() => 1);
    vi.spyOn(fs, 'fstatSync').mockImplementation(
      () => ({ isFile: () => false }) as fsType.Stats
    );
    vi.spyOn(fs, 'closeSync').mockImplementation(() => {});

    expect(cliPathRequiresNode(dirPath)).toBe(false);
  });

  it('returns false for scripts without node shebang', () => {
    const scriptPath = isWindows ? 'C:\\temp\\script' : '/tmp/script';
    const shebang = '#!/usr/bin/env python\nprint("hi")\n';

    vi.spyOn(fs, 'openSync').mockImplementation(() => 1);
    vi.spyOn(fs, 'fstatSync').mockImplementation(
      () => ({ isFile: () => true }) as fsType.Stats
    );
    vi.spyOn(fs, 'readSync').mockImplementation((_, buffer: ArrayBufferView) => {
      Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).write(shebang);
      return shebang.length;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation(() => {});

    expect(cliPathRequiresNode(scriptPath)).toBe(false);
  });

  it('returns false for non-node shebang scripts that reference node in the body', () => {
    const scriptPath = isWindows ? 'C:\\temp\\claude-wrapper' : '/tmp/claude-wrapper';
    const script = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'NODE_BIN="$(command -v node)"',
      'exec "$NODE_BIN" /path/to/cli.js "$@"',
      '',
    ].join('\n');

    vi.spyOn(fs, 'openSync').mockImplementation(() => 1);
    vi.spyOn(fs, 'fstatSync').mockImplementation(
      () => ({ isFile: () => true }) as fsType.Stats
    );
    vi.spyOn(fs, 'readSync').mockImplementation((_, buffer: ArrayBufferView) => {
      Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).write(script);
      return script.length;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation(() => {});

    expect(cliPathRequiresNode(scriptPath)).toBe(false);
  });

  it('returns false for .cmd files', () => {
    expect(cliPathRequiresNode('/path/to/claude.cmd')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(cliPathRequiresNode('/path/to/CLI.JS')).toBe(true);
    expect(cliPathRequiresNode('/path/to/cli.MJS')).toBe(true);
    expect(cliPathRequiresNode('/path/to/cli-wrapper.CJS')).toBe(true);
  });
});

describe('findNodeDirectory', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    Object.keys(process.env).forEach(key => delete process.env[key]);
    Object.assign(process.env, originalEnv);
  });

  it('uses NVM_SYMLINK when set on Windows', () => {
    if (!isWindows) {
      return;
    }

    const nvmSymlink = 'C:\\nvm\\symlink';
    const nodePath = path.join(nvmSymlink, 'node.exe');
    vi.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === nodePath);
    vi.spyOn(fs, 'statSync').mockImplementation(
      p => ({ isFile: () => String(p) === nodePath }) as fsType.Stats
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

    vi.spyOn(fs, 'existsSync').mockImplementation(p => {
      const candidate = String(p);
      return candidate === preferredNode || candidate === fallbackNode;
    });
    vi.spyOn(fs, 'statSync').mockImplementation(
      () => ({ isFile: () => true }) as fsType.Stats
    );
    mockExecuteAccess(preferredNode, fallbackNode);

    process.env.PATH = fallbackDir;

    const result = findNodeDirectory(preferredDir);
    expect(result).toBe(preferredDir);
  });

  it('returns full path for findNodeExecutable when available', () => {
    const nodeExecutable = isWindows ? 'node.exe' : 'node';
    const preferredDir = isWindows ? 'C:\\custom\\bin' : '/custom/bin';
    const preferredNode = path.join(preferredDir, nodeExecutable);

    vi.spyOn(fs, 'existsSync').mockImplementation(p => String(p) === preferredNode);
    vi.spyOn(fs, 'statSync').mockImplementation(
      () => ({ isFile: () => true }) as fsType.Stats
    );
    mockExecuteAccess(preferredNode);

    const result = findNodeExecutable(preferredDir);
    expect(result).toBe(preferredNode);
  });

  it('skips inaccessible and non-executable candidates in favor of a later usable one', () => {
    if (isWindows) return;

    const brokenNode = '/broken/bin/node';
    const badNode = '/bad/bin/node';
    const goodNode = '/good/bin/node';
    vi.spyOn(fs, 'existsSync').mockImplementation(p => {
      const candidate = String(p);
      return candidate === brokenNode || candidate === badNode || candidate === goodNode;
    });
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fsType.PathLike) => {
      if (String(p) === brokenNode) {
        throw Object.assign(new Error('EACCES: permission denied, stat'), { code: 'EACCES' });
      }
      return { isFile: () => true } as fsType.Stats;
    }) as typeof fs.statSync);
    mockExecuteAccess(goodNode);

    process.env.PATH = '';
    const search = `/broken/bin${SEP}/bad/bin${SEP}/good/bin`;
    expect(findNodeDirectory(search)).toBe('/good/bin');
    expect(findNodeExecutable(search)).toBe(goodNode);
  });

  it('reports no Node executable when every candidate lacks execute access', () => {
    if (isWindows) return;

    const firstNode = '/first/bin/node';
    const secondNode = '/second/bin/node';
    vi.spyOn(fs, 'existsSync').mockImplementation(p => {
      const candidate = String(p);
      return candidate === firstNode || candidate === secondNode;
    });
    vi.spyOn(fs, 'statSync').mockImplementation(
      () => ({ isFile: () => true }) as fsType.Stats
    );
    mockExecuteAccess();

    process.env.PATH = '';
    const search = `/first/bin${SEP}/second/bin`;
    expect(findNodeDirectory(search)).toBeNull();
    expect(findNodeExecutables(search)).toEqual([]);
  });
});

describe('getExtraBinaryPaths (Windows branches)', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.keys(process.env).forEach(key => delete process.env[key]);
    Object.assign(process.env, originalEnv);
    vi.resetModules();
  });

  async function loadWithWindowsPlatform(): Promise<typeof env> {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
    // Dynamic import needed to re-evaluate module with mocked platform
    return await import('@/core/process/env');
  }

  it('includes APPDATA npm path when APPDATA is set', async () => {
    process.env.APPDATA = '/mock/AppData/Roaming';
    process.env.LOCALAPPDATA = '/mock/AppData/Local';
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('npm');
    expect(result).toContain('Roaming');
  });

  it('includes LOCALAPPDATA nodejs paths', async () => {
    process.env.LOCALAPPDATA = '/mock/AppData/Local';
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('Local');
    expect(result).toContain('nodejs');
  });

  it('includes NVM_SYMLINK when set', async () => {
    process.env.NVM_SYMLINK = '/mock/nvm/symlink';
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('/mock/nvm/symlink');
  });

  it('includes NVM_HOME when set', async () => {
    process.env.NVM_HOME = '/mock/nvm/home';
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('/mock/nvm/home');
  });

  it('falls back to APPDATA/nvm when NVM_HOME not set', async () => {
    delete process.env.NVM_HOME;
    process.env.APPDATA = '/mock/AppData/Roaming';
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('nvm');
  });

  it('includes fnm default Node.js aliases without the PowerShell hook', async () => {
    process.env.APPDATA = '/mock/AppData/Roaming';
    process.env.LOCALAPPDATA = '/mock/AppData/Local';
    process.env.HOME = '/mock/home';
    process.env.FNM_DIR = '/mock/fnm';
    const entries = (await loadWithWindowsPlatform()).getEnhancedPath().split(';');
    expect(entries).toEqual(expect.arrayContaining([
      '/mock/fnm/aliases/default',
      '/mock/AppData/Roaming/fnm/aliases/default',
      '/mock/AppData/Local/fnm/aliases/default',
    ].map(entry => path.normalize(entry))));
    expect(entries).not.toContain(path.join('/mock/fnm', 'aliases', 'default', 'bin'));
  });

  it('includes pnpm, proto, nvs, Yarn, and WinGet locations', async () => {
    for (const key of ['PNPM_HOME', 'PROTO_HOME', 'NVS_HOME']) delete process.env[key];
    process.env.LOCALAPPDATA = '/mock/AppData/Local';
    process.env.USERPROFILE = '/mock/home';
    process.env.HOME = '/mock/home';
    let entries = (await loadWithWindowsPlatform()).getEnhancedPath().split(';');
    expect(entries).toEqual(expect.arrayContaining([
      '/mock/AppData/Local/pnpm',
      '/mock/home/.proto/shims',
      '/mock/home/.proto/bin',
      '/mock/AppData/Local/nvs/default',
      '/mock/AppData/Local/Yarn/bin',
      '/mock/AppData/Local/Microsoft/WinGet/Links',
    ].map(entry => path.normalize(entry))));

    process.env.PNPM_HOME = '/custom/pnpm';
    process.env.PROTO_HOME = '/custom/proto';
    process.env.NVS_HOME = '/custom/nvs';
    entries = (await loadWithWindowsPlatform()).getEnhancedPath().split(';');
    expect(entries).toEqual(expect.arrayContaining([
      '/custom/pnpm', path.join('/custom/proto', 'shims'), path.join('/custom/proto', 'bin'), path.join('/custom/nvs', 'default'),
    ]));
  });

  it('includes VOLTA_HOME/bin when set', async () => {
    process.env.VOLTA_HOME = '/mock/volta';
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('volta');
  });

  it('falls back to home/.volta/bin when VOLTA_HOME not set', async () => {
    delete process.env.VOLTA_HOME;
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('.volta');
  });

  it('includes ChocolateyInstall/bin when set', async () => {
    process.env.ChocolateyInstall = '/mock/choco';
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('choco');
  });

  it('falls back to ProgramData/chocolatey/bin when ChocolateyInstall not set', async () => {
    delete process.env.ChocolateyInstall;
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('chocolatey');
  });

  it('includes SCOOP paths when set', async () => {
    process.env.SCOOP = '/mock/scoop';
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('scoop');
    expect(result).toContain('shims');
  });

  it('falls back to home/scoop when SCOOP not set', async () => {
    delete process.env.SCOOP;
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('scoop');
  });

  it('includes Docker path under Program Files', async () => {
    process.env.ProgramFiles = '/mock/Program Files';
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('Docker');
  });

  it('includes home/.local/bin on Windows', async () => {
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain('.local');
  });

  it('includes home/.opencode/bin on Windows', async () => {
    process.env.HOME = '/mock/home';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    const segments = result.split(';');

    expect(segments).toContain(path.join('/mock/home', '.opencode', 'bin'));
  });

  it('uses semicolon separator on Windows', async () => {
    process.env.HOME = '/mock/home';
    process.env.PATH = '/existing';
    const mod = await loadWithWindowsPlatform();
    const result = mod.getEnhancedPath();
    expect(result).toContain(';');
  });
});

describe('Obsidian CLI path integration', () => {
  const originalPlatform = process.platform;
  const originalExecPath = process.execPath;
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'execPath', { value: originalExecPath });
    Object.keys(process.env).forEach(key => delete process.env[key]);
    Object.assign(process.env, originalEnv);
    vi.resetModules();
  });

  async function loadWithPlatform(platform: NodeJS.Platform, execPath: string): Promise<typeof env> {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: platform, writable: true });
    Object.defineProperty(process, 'execPath', { value: execPath, configurable: true });
    // Dynamic import needed to re-evaluate module with mocked platform/execPath
    return await import('@/core/process/env');
  }

  it.each([
    '/Applications/Obsidian.app/Contents/MacOS/Obsidian',
    '/Applications/Obsidian.app/Contents/Frameworks/Obsidian Helper (Renderer).app/Contents/MacOS/Obsidian Helper (Renderer)',
  ])('preserves inherited CLI precedence when running %s', async (execPath) => {
    const cliDirectory = '/custom/obsidian-cli/bin';
    const appDirectory = '/Applications/Obsidian.app/Contents/MacOS';
    process.env.PATH = `${cliDirectory}:${appDirectory}`;

    const mod = await loadWithPlatform('darwin', execPath);
    const segments = mod.getEnhancedPath().split(':');

    expect(segments).toContain(cliDirectory);
    expect(segments).toContain(appDirectory);
    expect(segments.indexOf(cliDirectory)).toBeLessThan(segments.indexOf(appDirectory));
  });

  it('does not add transient Linux AppImage mount dirs', async () => {
    const appImageExecPath = '/tmp/.mount_Obsidian-abcd1234/usr/bin/obsidian';
    const appImageDir = path.dirname(appImageExecPath);
    process.env.HOME = '/home/test';
    process.env.PATH = '';

    const mod = await loadWithPlatform('linux', appImageExecPath);
    const result = mod.getEnhancedPath();
    const segments = result.split(':');

    expect(segments).not.toContain(appImageDir);
    expect(segments).toContain('/usr/local/bin');
    expect(segments).toContain(path.join('/home/test', '.local', 'bin'));
  });
});

describe('environment variable parsing edge cases', () => {
  it('should skip lines without = sign', () => {
    const input = 'VALID=value\nINVALID_LINE\nANOTHER=test';
    const result = parseEnvironmentVariables(input);

    expect(result).toEqual({
      VALID: 'value',
      ANOTHER: 'test',
    });
  });

  it('should skip lines with = at start (no key)', () => {
    const input = '=value\nKEY=valid\n =also-no-key';
    const result = parseEnvironmentVariables(input);

    expect(result).toEqual({
      KEY: 'valid',
    });
  });

  it('should return empty object for empty input', () => {
    expect(parseEnvironmentVariables('')).toEqual({});
    expect(parseEnvironmentVariables('   ')).toEqual({});
    expect(parseEnvironmentVariables('\n\n')).toEqual({});
  });

  it('should handle values with spaces', () => {
    const input = 'MESSAGE=Hello World';
    const result = parseEnvironmentVariables(input);

    expect(result).toEqual({
      MESSAGE: 'Hello World',
    });
  });

  it('should not strip mismatched quotes', () => {
    const input = 'VAL1="not-closed\nVAL2=\'also-not-closed\nVAL3="mixed\'';
    const result = parseEnvironmentVariables(input);

    expect(result).toEqual({
      VAL1: '"not-closed',
      VAL2: "'also-not-closed",
      VAL3: '"mixed\'',
    });
  });

  it('should preserve quotes inside values', () => {
    const input = 'JSON={"key": "value"}';
    const result = parseEnvironmentVariables(input);

    expect(result).toEqual({
      JSON: '{"key": "value"}',
    });
  });
});

it('does not reopen a CLI whose directory already supplies Node', () => {
  const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  const stat = vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fsType.Stats);
  mockExecuteAccess('/cli/node');
  const open = vi.spyOn(fs, 'openSync').mockImplementation(() => { throw new Error('unnecessary read'); });
  try {
    getEnhancedPath(undefined, '/cli/claude');
    expect(open).not.toHaveBeenCalled();
  } finally { exists.mockRestore(); stat.mockRestore(); open.mockRestore(); }
});

vi.mock('fs', async () => ({ ...await vi.importActual<typeof import('fs')>('fs') }));
