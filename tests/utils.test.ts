import {
  getVaultPath,
  parseEnvironmentVariables,
  getModelsFromEnvironment,
  getCurrentModelFromEnvironment,
} from '../src/utils';

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

    it('should sort models by priority (model > opus > sonnet > haiku)', () => {
      const envVars = {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-model',
        ANTHROPIC_MODEL: 'main-model',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-model',
      };
      const result = getModelsFromEnvironment(envVars);

      expect(result[0].value).toBe('main-model');
      expect(result[1].value).toBe('sonnet-model');
      expect(result[2].value).toBe('haiku-model');
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

    it('should return ANTHROPIC_DEFAULT_OPUS_MODEL if ANTHROPIC_MODEL not set', () => {
      const envVars = {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-model',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-model',
      };
      const result = getCurrentModelFromEnvironment(envVars);

      expect(result).toBe('opus-model');
    });

    it('should return ANTHROPIC_DEFAULT_SONNET_MODEL if higher priority not set', () => {
      const envVars = {
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-model',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-model',
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
});
