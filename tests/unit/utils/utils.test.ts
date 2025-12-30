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
  isPathInAllowedExportPaths,
  isPathWithinVault,
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
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return first matching Claude CLI path', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
      jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => p === '/home/test/.local/bin/claude');

      expect(findClaudeCLIPath()).toBe('/home/test/.local/bin/claude');
    });

    it('should return null when Claude CLI is not found', () => {
      jest.spyOn(os, 'homedir').mockReturnValue('/home/test');
      jest.spyOn(fs, 'existsSync').mockReturnValue(false as any);

      expect(findClaudeCLIPath()).toBeNull();
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
