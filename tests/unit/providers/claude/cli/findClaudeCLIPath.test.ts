import type * as fsType from 'fs';
import type * as osType from 'os';
import type * as pathType from 'path';

const fs = jest.requireActual<typeof fsType>('fs');
const os = jest.requireActual<typeof osType>('os');
const path = jest.requireActual<typeof pathType>('path');

import { findClaudeCLIPath } from '@/providers/claude/cli/findClaudeCLIPath';

const isWindows = process.platform === 'win32';

describe('findClaudeCLIPath', () => {
  const originalPlatform = process.platform;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.PATH = '';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env = originalEnv;
  });

  describe('on Unix/macOS', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
    });

    function mockExistingFile(...paths: string[]) {
      const pathSet = new Set(paths.map(value => path.normalize(value)));
      jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => pathSet.has(p));
      jest.spyOn(fs, 'statSync').mockImplementation((p: any) => ({
        isFile: () => pathSet.has(String(p)),
      }) as fsType.Stats);
    }

    it('should return first matching Claude CLI path', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
      mockExistingFile('/home/test/.local/bin/claude');

      expect(findClaudeCLIPath()).toBe(path.normalize('/home/test/.local/bin/claude'));
    });

    it('should return null when Claude CLI is not found', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
      jest.spyOn(fs, 'existsSync').mockReturnValue(false as any);

      expect(findClaudeCLIPath()).toBeNull();
    });

    it('should check cli-wrapper.cjs paths as fallback on Unix', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
      mockExistingFile('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs');

      expect(findClaudeCLIPath()).toBe(path.normalize('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs'));
    });

    it('should resolve Claude CLI from custom PATH', () => {
      mockExistingFile('/custom/bin/claude');

      const customPath = '/custom/bin:/usr/bin';
      expect(findClaudeCLIPath(customPath)).toBe(path.normalize('/custom/bin/claude'));
    });

    it('should expand home directory in custom PATH', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
      mockExistingFile('/home/test/bin/claude');

      const customPath = '~/bin:/usr/bin';
      expect(findClaudeCLIPath(customPath)).toBe(path.normalize('/home/test/bin/claude'));
    });

    it('should not return a directory path even if it exists', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
      const dirPath = path.join('/home/test', '.local', 'bin', 'claude');
      jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => p === dirPath);
      jest.spyOn(fs, 'statSync').mockImplementation(() => ({
        isFile: () => false,
      }) as fsType.Stats);

      expect(findClaudeCLIPath()).toBeNull();
    });
  });

  describe('on Windows', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env.ProgramFiles = 'C:\\Program Files';
      process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)';
      process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    });

    function mockExistingFile(...paths: string[]) {
      const pathSet = new Set(paths);
      jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => pathSet.has(p));
      jest.spyOn(fs, 'statSync').mockImplementation((p: any) => ({
        isFile: () => pathSet.has(String(p)),
      }) as fsType.Stats);
    }

    it('should prefer .exe when both .exe and cli-wrapper.cjs exist', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\test');
      const exePath = path.join('C:\\Users\\test', '.claude', 'local', 'claude.exe');
      const cliWrapperPath = path.join('C:\\Users\\test', 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli-wrapper.cjs');
      mockExistingFile(exePath, cliWrapperPath);

      expect(findClaudeCLIPath()).toBe(exePath);
    });

    it('should prioritize cli-wrapper.cjs over .cmd files on Windows', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\test');
      // Note: path.join uses actual platform separator, so we match against that
      const cliWrapperPath = path.join('C:\\Users\\test', 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli-wrapper.cjs');
      const cmdPath = path.join('C:\\Users\\test', 'AppData', 'Roaming', 'npm', 'claude.cmd');
      mockExistingFile(cmdPath, cliWrapperPath);

      expect(findClaudeCLIPath()).toBe(cliWrapperPath);
    });

    it('should find cli-wrapper.cjs in custom npm global path via npm_config_prefix', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\test');
      process.env.npm_config_prefix = 'D:\\nodejs\\node_global';
      const expectedPath = path.join('D:\\nodejs\\node_global', 'node_modules', '@anthropic-ai', 'claude-code', 'cli-wrapper.cjs');
      mockExistingFile(expectedPath);

      expect(findClaudeCLIPath()).toBe(expectedPath);
    });

    it('should fall back to .exe if package entrypoint is not found', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\test');
      const expectedPath = path.join('C:\\Users\\test', '.claude', 'local', 'claude.exe');
      mockExistingFile(expectedPath);

      expect(findClaudeCLIPath()).toBe(expectedPath);
    });

    it('should ignore .cmd fallback on Windows', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\test');
      const expectedPath = path.join('C:\\Users\\test', 'AppData', 'Roaming', 'npm', 'claude.cmd');
      mockExistingFile(expectedPath);

      expect(findClaudeCLIPath()).toBeNull();
    });

    it('should return null when no CLI is found on Windows', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\test');
      jest.spyOn(fs, 'existsSync').mockReturnValue(false as any);

      expect(findClaudeCLIPath()).toBeNull();
    });

    it('should resolve cli-wrapper.cjs from custom PATH npm prefix', () => {
      const npmBin = 'C:\\Users\\test\\AppData\\Roaming\\npm';
      const cliWrapperPath = path.join(npmBin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli-wrapper.cjs');
      mockExistingFile(cliWrapperPath);

      const customPath = `${npmBin};C:\\Windows\\System32`;
      expect(findClaudeCLIPath(customPath)).toBe(cliWrapperPath);
    });

    it('should prefer cli-wrapper.cjs over the extension-less npm sh shim', () => {
      const npmBin = 'D:\\npm-global';
      const shimPath = path.join(npmBin, 'claude');
      const cliWrapperPath = path.join(npmBin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli-wrapper.cjs');
      mockExistingFile(shimPath, cliWrapperPath);

      const customPath = `${npmBin};C:\\Windows\\System32`;
      expect(findClaudeCLIPath(customPath)).toBe(cliWrapperPath);
    });

    it('should ignore the extension-less npm sh shim when no package entrypoint exists', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\test');
      const npmBin = 'D:\\npm-global';
      mockExistingFile(path.join(npmBin, 'claude'));

      const customPath = `${npmBin};C:\\Windows\\System32`;
      expect(findClaudeCLIPath(customPath)).toBeNull();
    });

    it('should not return a directory path even if it exists', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\test');
      const dirPath = path.join('C:\\Users\\test', '.claude', 'local', 'claude');
      // Simulate a directory named 'claude' (exists but isFile returns false)
      jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => p === dirPath);
      jest.spyOn(fs, 'statSync').mockImplementation(() => ({
        isFile: () => false,
      }) as fsType.Stats);

      expect(findClaudeCLIPath()).toBeNull();
    });
  });
});

describe('native platform CLI discovery', () => {
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
      os.homedir(), ...(isWindows ? ['AppData', 'Roaming', 'npm'] : ['.npm-global', 'lib']), 'node_modules',
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
      os.homedir(), ...(isWindows ? ['AppData', 'Roaming', 'npm'] : ['.npm-global', 'lib']), 'node_modules',
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
    const envBin = isWindows ? 'C:\\env\\specific\\bin' : '/env/specific/bin';
    const envClaudePath = path.join(envBin, isWindows ? 'claude.exe' : 'claude');
    const originalPath = process.env.PATH;
    process.env.PATH = [envBin, originalPath ?? ''].join(path.delimiter);

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
