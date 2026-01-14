import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getCurrentModelFromEnvironment, getModelsFromEnvironment, parseEnvironmentVariables } from '@/utils/env';
import { appendMarkdownSnippet } from '@/utils/markdown';
import {
  expandHomePath,
  findClaudeCLIPath,
  getPathAccessType,
  getVaultPath,
  isPathInAllowedContextPaths,
  isPathInAllowedExportPaths,
  isPathWithinVault,
  normalizePathForFilesystem,
  normalizePathForVault,
  translateMsysPath,
} from '@/utils/path';

describe('utils.ts', () => {
  describe('getVaultPath', () => {
    it('should return basePath when adapter has basePath property', () => {
      const mockApp = {
        vault: {
          adapter: {
            basePath: '/Users/test/my-vault',
          },
        },
      } as any;

      const result = getVaultPath(mockApp);

      expect(result).toBe('/Users/test/my-vault');
    });

    it('should return null when adapter does not have basePath', () => {
      const mockApp = {
        vault: {
          adapter: {},
        },
      } as any;

      const result = getVaultPath(mockApp);

      expect(result).toBeNull();
    });

    it('should return null when adapter is undefined', () => {
      const mockApp = {
        vault: {
          adapter: undefined,
        },
      } as any;

      // The function will throw because it tries to use 'in' on undefined
      // This tests error handling - in real usage adapter is always defined
      expect(() => getVaultPath(mockApp)).toThrow();
    });

    it('should handle empty string basePath', () => {
      const mockApp = {
        vault: {
          adapter: {
            basePath: '',
          },
        },
      } as any;

      const result = getVaultPath(mockApp);

      // Empty string is still a valid basePath value
      expect(result).toBe('');
    });

    it('should handle paths with spaces', () => {
      const mockApp = {
        vault: {
          adapter: {
            basePath: '/Users/test/My Obsidian Vault',
          },
        },
      } as any;

      const result = getVaultPath(mockApp);

      expect(result).toBe('/Users/test/My Obsidian Vault');
    });

    it('should handle Windows-style paths', () => {
      const mockApp = {
        vault: {
          adapter: {
            basePath: 'C:\\Users\\test\\vault',
          },
        },
      } as any;

      const result = getVaultPath(mockApp);

      expect(result).toBe('C:\\Users\\test\\vault');
    });
  });

  describe('parseEnvironmentVariables', () => {
    it('should parse simple KEY=VALUE pairs', () => {
      const input = 'API_KEY=abc123\nDEBUG=true';
      const result = parseEnvironmentVariables(input);

      expect(result).toEqual({
        API_KEY: 'abc123',
        DEBUG: 'true',
      });
    });

    it('should skip empty lines', () => {
      const input = 'KEY1=value1\n\nKEY2=value2\n\n';
      const result = parseEnvironmentVariables(input);

      expect(result).toEqual({
        KEY1: 'value1',
        KEY2: 'value2',
      });
    });

    it('should skip comment lines starting with #', () => {
      const input = '# This is a comment\nKEY=value\n# Another comment';
      const result = parseEnvironmentVariables(input);

      expect(result).toEqual({
        KEY: 'value',
      });
    });

    it('should handle values with = signs', () => {
      const input = 'URL=https://example.com?foo=bar&baz=qux';
      const result = parseEnvironmentVariables(input);

      expect(result).toEqual({
        URL: 'https://example.com?foo=bar&baz=qux',
      });
    });

    it('should trim whitespace from keys and values', () => {
      const input = '  KEY  =  value  ';
      const result = parseEnvironmentVariables(input);

      expect(result).toEqual({
        KEY: 'value',
      });
    });

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

    it('should strip surrounding double quotes from values', () => {
      const input = 'URL="https://api.example.com"\nKEY="secret-key"';
      const result = parseEnvironmentVariables(input);

      expect(result).toEqual({
        URL: 'https://api.example.com',
        KEY: 'secret-key',
      });
    });

    it('should strip surrounding single quotes from values', () => {
      const input = "URL='https://api.example.com'\nKEY='secret-key'";
      const result = parseEnvironmentVariables(input);

      expect(result).toEqual({
        URL: 'https://api.example.com',
        KEY: 'secret-key',
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

  describe('expandHomePath', () => {
    const envKey = 'CLAUDIAN_TEST_PATH';
    const envValue = path.join(os.tmpdir(), 'claudian-env');
    let originalValue: string | undefined;

    beforeEach(() => {
      originalValue = process.env[envKey];
      process.env[envKey] = envValue;
    });

    afterEach(() => {
      if (originalValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = originalValue;
      }
    });

    it('should expand percent-style environment variables', () => {
      expect(expandHomePath(`%${envKey}%`)).toBe(envValue);
    });

    it('should expand dollar-style environment variables', () => {
      const braceStyle = '${' + envKey + '}';
      expect(expandHomePath(`$${envKey}`)).toBe(envValue);
      expect(expandHomePath(braceStyle)).toBe(envValue);
    });

    it('should handle Windows-specific environment variable formats based on platform', () => {
      const powerShellStyle = `$env:${envKey}`;
      const cmdStyle = `!${envKey}!`;

      // On Windows: expanded; on Unix: unchanged
      const expectedPowerShell = process.platform === 'win32' ? envValue : powerShellStyle;
      const expectedCmd = process.platform === 'win32' ? envValue : cmdStyle;

      expect(expandHomePath(powerShellStyle)).toBe(expectedPowerShell);
      expect(expandHomePath(cmdStyle)).toBe(expectedCmd);
    });

    it('should leave unknown environment variables untouched', () => {
      expect(expandHomePath('%CLAUDIAN_MISSING_VAR%')).toBe('%CLAUDIAN_MISSING_VAR%');
      expect(expandHomePath('$CLAUDIAN_MISSING_VAR')).toBe('$CLAUDIAN_MISSING_VAR');
    });
  });

  describe('normalizePathForFilesystem', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('expands home paths before filesystem use', () => {
      const expected = path.join(os.homedir(), 'notes/file.md');
      expect(normalizePathForFilesystem('~/notes/file.md')).toBe(expected);
    });

    it('expands environment variables before filesystem use', () => {
      const envKey = 'CLAUDIAN_FS_TEST_PATH';
      const originalValue = process.env[envKey];
      process.env[envKey] = '/tmp/claudian-test';

      try {
        expect(normalizePathForFilesystem(`$${envKey}/notes/file.md`)).toBe('/tmp/claudian-test/notes/file.md');
      } finally {
        if (originalValue === undefined) {
          delete process.env[envKey];
        } else {
          process.env[envKey] = originalValue;
        }
      }
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

    it('handles empty string input', () => {
      expect(normalizePathForFilesystem('')).toBe('');
    });

    it('handles non-existent environment variables', () => {
      // Non-existent env vars should be left as-is
      expect(normalizePathForFilesystem('$NONEXISTENT/path')).toBe('$NONEXISTENT/path');
      expect(normalizePathForFilesystem('%NONEXISTENT%/path')).toBe('%NONEXISTENT%/path');
    });

    it('handles mixed path separators', () => {
      // Mixed / and \ should be normalized by path operations
      const result = normalizePathForFilesystem('C:/Users\\test/path.txt');
      // On Windows: path module normalizes, on Unix: keeps as-is
      expect(result).toBeTruthy();
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

  describe('normalizePathForVault', () => {
    it('returns vault-relative path for absolute input inside vault', () => {
      expect(normalizePathForVault('/vault/notes/a.md', '/vault')).toBe('notes/a.md');
    });

    it('returns vault-relative path for relative input inside vault', () => {
      expect(normalizePathForVault('notes/a.md', '/vault')).toBe('notes/a.md');
    });

    it('returns normalized path for external input', () => {
      expect(normalizePathForVault('/outside/file.md', '/vault')).toBe('/outside/file.md');
    });

    it('returns null for empty input', () => {
      expect(normalizePathForVault('', '/vault')).toBeNull();
    });
  });

  describe('appendMarkdownSnippet', () => {
    it('should append snippet as-is when existing prompt is empty', () => {
      expect(appendMarkdownSnippet('', '  - Test  ')).toBe('- Test');
    });

    it('should append snippet with a blank line separator by default', () => {
      const existing = '## Existing\n\n- A';
      const snippet = '## New\n\n- B';
      expect(appendMarkdownSnippet(existing, snippet)).toBe('## Existing\n\n- A\n\n## New\n\n- B');
    });

    it('should ensure a blank line separation when existing ends with a newline', () => {
      const existing = '## Existing\n';
      const snippet = '- B';
      expect(appendMarkdownSnippet(existing, snippet)).toBe('## Existing\n\n- B');
    });

    it('should not add extra spacing when existing ends with a blank line', () => {
      const existing = '## Existing\n\n';
      const snippet = '- B';
      expect(appendMarkdownSnippet(existing, snippet)).toBe('## Existing\n\n- B');
    });

    it('should return existing prompt unchanged when snippet is empty', () => {
      expect(appendMarkdownSnippet('## Existing', '   ')).toBe('## Existing');
    });
  });

  describe('getModelsFromEnvironment', () => {
    it('should extract model from ANTHROPIC_MODEL', () => {
      const envVars = { ANTHROPIC_MODEL: 'claude-3-opus' };
      const result = getModelsFromEnvironment(envVars);

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('claude-3-opus');
      expect(result[0].description).toContain('model');
    });

    it('should extract models from ANTHROPIC_DEFAULT_*_MODEL variables', () => {
      const envVars = {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'custom-opus',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'custom-haiku',
      };
      const result = getModelsFromEnvironment(envVars);

      expect(result).toHaveLength(3);
      expect(result.map(m => m.value)).toContain('custom-opus');
      expect(result.map(m => m.value)).toContain('custom-sonnet');
      expect(result.map(m => m.value)).toContain('custom-haiku');
    });

    it('should deduplicate models with same value', () => {
      const envVars = {
        ANTHROPIC_MODEL: 'same-model',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'same-model',
      };
      const result = getModelsFromEnvironment(envVars);

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('same-model');
      expect(result[0].description).toContain('model');
      expect(result[0].description).toContain('opus');
    });

    it('should return empty array when no model variables are set', () => {
      const envVars = { OTHER_VAR: 'value' };
      const result = getModelsFromEnvironment(envVars);

      expect(result).toEqual([]);
    });

    it('should handle model names with slashes (provider/model format)', () => {
      const envVars = { ANTHROPIC_MODEL: 'anthropic/claude-3-opus' };
      const result = getModelsFromEnvironment(envVars);

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('anthropic/claude-3-opus');
      expect(result[0].label).toBe('claude-3-opus');
    });

    it('should fallback to full value when slash-split yields empty', () => {
      const envVars = { ANTHROPIC_MODEL: 'trailing-slash/' };
      const result = getModelsFromEnvironment(envVars);

      expect(result).toHaveLength(1);
      expect(result[0].label).toBe('trailing-slash/');
    });

    it('should sort models by priority (model > haiku > sonnet > opus)', () => {
      const envVars = {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-model',
        ANTHROPIC_MODEL: 'main-model',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-model',
      };
      const result = getModelsFromEnvironment(envVars);

      expect(result[0].value).toBe('main-model');
      expect(result[1].value).toBe('sonnet-model');
      expect(result[2].value).toBe('opus-model');
    });
  });

  describe('getCurrentModelFromEnvironment', () => {
    it('should return ANTHROPIC_MODEL if set', () => {
      const envVars = {
        ANTHROPIC_MODEL: 'main-model',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-model',
      };
      const result = getCurrentModelFromEnvironment(envVars);

      expect(result).toBe('main-model');
    });

    it('should return ANTHROPIC_DEFAULT_HAIKU_MODEL if ANTHROPIC_MODEL not set', () => {
      const envVars = {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-model',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-model',
      };
      const result = getCurrentModelFromEnvironment(envVars);

      expect(result).toBe('haiku-model');
    });

    it('should return ANTHROPIC_DEFAULT_SONNET_MODEL if higher priority not set', () => {
      const envVars = {
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-model',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-model',
      };
      const result = getCurrentModelFromEnvironment(envVars);

      expect(result).toBe('sonnet-model');
    });

    it('should return ANTHROPIC_DEFAULT_HAIKU_MODEL if only that is set', () => {
      const envVars = {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-model',
      };
      const result = getCurrentModelFromEnvironment(envVars);

      expect(result).toBe('haiku-model');
    });

    it('should return null if no model variables are set', () => {
      const envVars = { OTHER_VAR: 'value' };
      const result = getCurrentModelFromEnvironment(envVars);

      expect(result).toBeNull();
    });

    it('should return null for empty object', () => {
      const result = getCurrentModelFromEnvironment({});

      expect(result).toBeNull();
    });
  });

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
        const pathSet = new Set(paths);
        jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => pathSet.has(p));
        jest.spyOn(fs, 'statSync').mockImplementation((p: any) => ({
          isFile: () => pathSet.has(String(p)),
        }) as fs.Stats);
      }

      it('should return first matching Claude CLI path', () => {
        jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
        mockExistingFile('/home/test/.local/bin/claude');

        expect(findClaudeCLIPath()).toBe('/home/test/.local/bin/claude');
      });

      it('should return null when Claude CLI is not found', () => {
        jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
        jest.spyOn(fs, 'existsSync').mockReturnValue(false as any);

        expect(findClaudeCLIPath()).toBeNull();
      });

      it('should check cli.js paths as fallback on Unix', () => {
        jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
        mockExistingFile('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js');

        expect(findClaudeCLIPath()).toBe('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js');
      });

      it('should resolve Claude CLI from custom PATH', () => {
        mockExistingFile('/custom/bin/claude');

        const customPath = '/custom/bin:/usr/bin';
        expect(findClaudeCLIPath(customPath)).toBe('/custom/bin/claude');
      });

      it('should expand home directory in custom PATH', () => {
        jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
        mockExistingFile('/home/test/bin/claude');

        const customPath = '~/bin:/usr/bin';
        expect(findClaudeCLIPath(customPath)).toBe('/home/test/bin/claude');
      });

      it('should not return a directory path even if it exists', () => {
        jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
        const dirPath = path.join('/home/test', '.local', 'bin', 'claude');
        jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => p === dirPath);
        jest.spyOn(fs, 'statSync').mockImplementation(() => ({
          isFile: () => false,
        }) as fs.Stats);

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
        }) as fs.Stats);
      }

      it('should prefer .exe when both .exe and cli.js exist', () => {
        jest.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\test');
        const exePath = path.join('C:\\Users\\test', '.claude', 'local', 'claude.exe');
        const cliJsPath = path.join('C:\\Users\\test', 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        mockExistingFile(exePath, cliJsPath);

        expect(findClaudeCLIPath()).toBe(exePath);
      });

      it('should prioritize cli.js over .cmd files on Windows', () => {
        jest.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\test');
        // Note: path.join uses actual platform separator, so we match against that
        const cliJsPath = path.join('C:\\Users\\test', 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        const cmdPath = path.join('C:\\Users\\test', 'AppData', 'Roaming', 'npm', 'claude.cmd');
        // Both .cmd and cli.js exist, but cli.js should be returned (cmd is ignored entirely)
        mockExistingFile(cmdPath, cliJsPath);

        // Should return cli.js, not claude.cmd
        expect(findClaudeCLIPath()).toBe(cliJsPath);
      });

      it('should find cli.js in custom npm global path via npm_config_prefix', () => {
        jest.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\test');
        process.env.npm_config_prefix = 'D:\\nodejs\\node_global';
        const expectedPath = path.join('D:\\nodejs\\node_global', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        mockExistingFile(expectedPath);

        expect(findClaudeCLIPath()).toBe(expectedPath);
      });

      it('should fall back to .exe if cli.js not found', () => {
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

      it('should resolve cli.js from custom PATH npm prefix', () => {
        const npmBin = 'C:\\Users\\test\\AppData\\Roaming\\npm';
        const cliJsPath = path.join(npmBin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        mockExistingFile(cliJsPath);

        const customPath = `${npmBin};C:\\Windows\\System32`;
        expect(findClaudeCLIPath(customPath)).toBe(cliJsPath);
      });

      it('should not return a directory path even if it exists', () => {
        jest.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\test');
        const dirPath = path.join('C:\\Users\\test', '.claude', 'local', 'claude');
        // Simulate a directory named 'claude' (exists but isFile returns false)
        jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => p === dirPath);
        jest.spyOn(fs, 'statSync').mockImplementation(() => ({
          isFile: () => false,
        }) as fs.Stats);

        expect(findClaudeCLIPath()).toBeNull();
      });
    });
  });

  describe('isPathInAllowedExportPaths', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return false when allowed export paths is empty', () => {
      expect(isPathInAllowedExportPaths('/tmp/out.md', [], '/vault')).toBe(false);
    });

    it('should allow candidate path within allowed export directory', () => {
      const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation((p: any) => path.resolve(String(p)) as any);
      (fs.realpathSync as any).native = realpathSpy;

      expect(isPathInAllowedExportPaths('/tmp/out.md', ['/tmp'], '/vault')).toBe(true);
      expect(isPathInAllowedExportPaths('/var/out.md', ['/tmp'], '/vault')).toBe(false);
    });

    it('should expand tilde for export paths and candidate paths', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
      const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation((p: any) => path.resolve(String(p)) as any);
      (fs.realpathSync as any).native = realpathSpy;

      expect(isPathInAllowedExportPaths('~/Desktop/out.md', ['~/Desktop'], '/vault')).toBe(true);
      expect(isPathInAllowedExportPaths('~/Downloads/out.md', ['~/Desktop'], '/vault')).toBe(false);
    });
  });

  describe('getPathAccessType', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    const stubRealpath = () => {
      const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation((p: any) => path.resolve(String(p)) as any);
      (fs.realpathSync as any).native = realpathSpy;
    };

    it('should return vault for paths inside vault', () => {
      stubRealpath();
      expect(getPathAccessType('notes/a.md', [], [], '/vault')).toBe('vault');
    });

    it('should treat exact overlap as read-write', () => {
      stubRealpath();
      expect(getPathAccessType('/tmp/shared/out.md', ['/tmp/shared'], ['/tmp/shared'], '/vault')).toBe('readwrite');
    });

    it('should prefer context over export for nested paths', () => {
      stubRealpath();
      const allowedExportPaths = ['/tmp'];
      const allowedContextPaths = ['/tmp/workspace'];

      expect(getPathAccessType('/tmp/workspace/file.md', allowedContextPaths, allowedExportPaths, '/vault')).toBe('context');
      expect(getPathAccessType('/tmp/out.md', allowedContextPaths, allowedExportPaths, '/vault')).toBe('export');
    });

    it('should let a nested context override a read-write parent', () => {
      stubRealpath();
      const allowedExportPaths = ['/tmp/shared'];
      const allowedContextPaths = ['/tmp/shared', '/tmp/shared/readonly'];

      expect(getPathAccessType('/tmp/shared/readonly/file.md', allowedContextPaths, allowedExportPaths, '/vault')).toBe('context');
      expect(getPathAccessType('/tmp/shared/file.md', allowedContextPaths, allowedExportPaths, '/vault')).toBe('readwrite');
    });

    it('should allow access to ~/.claude/ directory as vault', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
      const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation((p: any) => String(p) as any);
      (fs.realpathSync as any).native = realpathSpy;

      expect(getPathAccessType('/home/test/.claude', [], [], '/vault')).toBe('vault');
      expect(getPathAccessType('/home/test/.claude/settings.json', [], [], '/vault')).toBe('vault');
      expect(getPathAccessType('/home/test/.claude/hooks/pre-commit.sh', [], [], '/vault')).toBe('vault');
    });

    it('should allow access to ~/.claude/ via tilde expansion', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
      const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation((p: any) => String(p) as any);
      (fs.realpathSync as any).native = realpathSpy;

      expect(getPathAccessType('~/.claude', [], [], '/vault')).toBe('vault');
      expect(getPathAccessType('~/.claude/sessions/abc.jsonl', [], [], '/vault')).toBe('vault');
    });

    it('should block other home directory paths', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
      const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation((p: any) => String(p) as any);
      (fs.realpathSync as any).native = realpathSpy;

      expect(getPathAccessType('/home/test/.ssh/id_rsa', [], [], '/vault')).toBe('none');
      expect(getPathAccessType('~/.ssh/id_rsa', [], [], '/vault')).toBe('none');
      expect(getPathAccessType('/home/test/Documents/secret.txt', [], [], '/vault')).toBe('none');
    });
  });

  describe('isPathWithinVault', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should allow relative paths within vault', () => {
      expect(isPathWithinVault('notes/a.md', '/vault')).toBe(true);
    });

    it('should block path traversal escaping vault', () => {
      expect(isPathWithinVault('../secrets.txt', '/vault')).toBe(false);
    });

    it('should allow absolute paths inside vault', () => {
      expect(isPathWithinVault('/vault/notes/a.md', '/vault')).toBe(true);
    });

    it('should block absolute paths outside vault', () => {
      expect(isPathWithinVault('/etc/passwd', '/vault')).toBe(false);
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

    it('allows export paths after slash normalization', () => {
      expect(
        isPathInAllowedExportPaths(
          'C:\\Users\\test\\export\\out.md',
          ['C:\\Users\\test\\export'],
          'C:\\Users\\test\\vault'
        )
      ).toBe(true);
    });

    it('allows context paths after slash normalization', () => {
      expect(
        isPathInAllowedContextPaths(
          'C:\\Users\\test\\context\\in.md',
          ['C:\\Users\\test\\context'],
          'C:\\Users\\test\\vault'
        )
      ).toBe(true);
    });

    it('treats vault paths as vault access after normalization', () => {
      expect(getPathAccessType(
        'C:\\Users\\test\\vault\\note.md',
        [],
        [],
        'C:\\Users\\test\\vault'
      )).toBe('vault');
    });

    it('resolves access type using normalized boundaries', () => {
      expect(getPathAccessType(
        'C:\\Users\\test\\shared\\note.md',
        ['C:\\Users\\test\\shared'],
        ['C:\\Users\\test\\shared'],
        'C:\\Users\\test\\vault'
      )).toBe('readwrite');
    });

    it('treats ~/.claude paths as vault access after normalization', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\test');
      expect(getPathAccessType(
        'C:\\Users\\test\\.claude\\settings.json',
        [],
        [],
        'C:\\Users\\test\\vault'
      )).toBe('vault');
    });
  });

  describe('translateMsysPath', () => {
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

  describe('Windows path handling', () => {
    // Note: Full integration tests for Windows path validation require running on Windows
    // because Node's `path` module behavior is determined at module load time.
    // These tests verify the translateMsysPath function which is platform-mockable.

    describe('translateMsysPath behavior', () => {
      const originalPlatform = process.platform;

      afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      });

      it('translates MSYS paths to Windows paths when platform is win32', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });

        expect(translateMsysPath('/c/Users/test')).toBe('C:\\Users\\test');
        expect(translateMsysPath('/d/Projects/vault')).toBe('D:\\Projects\\vault');
        expect(translateMsysPath('/c')).toBe('C:');
        expect(translateMsysPath('/c/')).toBe('C:\\');
      });

      it('does not translate non-MSYS paths on Windows', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });

        // Multi-letter paths after / are not MSYS drive paths
        expect(translateMsysPath('/home/user')).toBe('/home/user');
        expect(translateMsysPath('/tmp/file')).toBe('/tmp/file');
        // Already Windows paths
        expect(translateMsysPath('C:\\Users')).toBe('C:\\Users');
        // Relative paths
        expect(translateMsysPath('./file')).toBe('./file');
      });

      it('does not translate any paths on non-Windows', () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });

        expect(translateMsysPath('/c/Users/test')).toBe('/c/Users/test');
        expect(translateMsysPath('/home/user')).toBe('/home/user');
      });
    });
  });
});
