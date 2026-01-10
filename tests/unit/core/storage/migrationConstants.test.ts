import {
  CLAUDIAN_ONLY_FIELDS,
  convertEnvObjectToString,
  DEPRECATED_FIELDS,
  mergeEnvironmentVariables,
  MIGRATABLE_CLAUDIAN_FIELDS,
} from '@/core/storage/migrationConstants';

describe('migrationConstants', () => {
  describe('CLAUDIAN_ONLY_FIELDS', () => {
    it('contains all expected user preference fields', () => {
      expect(CLAUDIAN_ONLY_FIELDS.has('userName')).toBe(true);
    });

    it('contains all expected security settings', () => {
      expect(CLAUDIAN_ONLY_FIELDS.has('enableBlocklist')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('blockedCommands')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('permissionMode')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('lastNonPlanPermissionMode')).toBe(true);
    });

    it('contains all expected model & thinking fields', () => {
      expect(CLAUDIAN_ONLY_FIELDS.has('model')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('thinkingBudget')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('enableAutoTitleGeneration')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('titleGenerationModel')).toBe(true);
    });

    it('contains all expected content settings', () => {
      expect(CLAUDIAN_ONLY_FIELDS.has('excludedTags')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('mediaFolder')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('systemPrompt')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('allowedExportPaths')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('persistentExternalContextPaths')).toBe(true);
    });

    it('contains all expected environment fields', () => {
      expect(CLAUDIAN_ONLY_FIELDS.has('environmentVariables')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('envSnippets')).toBe(true);
    });

    it('contains all expected UI settings', () => {
      expect(CLAUDIAN_ONLY_FIELDS.has('keyboardNavigation')).toBe(true);
    });

    it('contains all expected CLI path fields', () => {
      expect(CLAUDIAN_ONLY_FIELDS.has('claudeCliPath')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('claudeCliPaths')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('loadUserClaudeSettings')).toBe(true);
    });

    it('contains deprecated fields', () => {
      expect(CLAUDIAN_ONLY_FIELDS.has('allowedContextPaths')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('showToolUse')).toBe(true);
      expect(CLAUDIAN_ONLY_FIELDS.has('toolCallExpandedByDefault')).toBe(true);
    });
  });

  describe('MIGRATABLE_CLAUDIAN_FIELDS', () => {
    it('contains user preferences', () => {
      expect(MIGRATABLE_CLAUDIAN_FIELDS.has('userName')).toBe(true);
    });

    it('contains security settings', () => {
      expect(MIGRATABLE_CLAUDIAN_FIELDS.has('enableBlocklist')).toBe(true);
      expect(MIGRATABLE_CLAUDIAN_FIELDS.has('blockedCommands')).toBe(true);
      expect(MIGRATABLE_CLAUDIAN_FIELDS.has('permissionMode')).toBe(true);
    });

    it('contains model settings', () => {
      expect(MIGRATABLE_CLAUDIAN_FIELDS.has('model')).toBe(true);
      expect(MIGRATABLE_CLAUDIAN_FIELDS.has('thinkingBudget')).toBe(true);
    });

    it('contains environment fields including legacy env', () => {
      expect(MIGRATABLE_CLAUDIAN_FIELDS.has('environmentVariables')).toBe(true);
      expect(MIGRATABLE_CLAUDIAN_FIELDS.has('env')).toBe(true);
    });

    it('excludes deprecated fields', () => {
      expect(MIGRATABLE_CLAUDIAN_FIELDS.has('allowedContextPaths')).toBe(false);
      expect(MIGRATABLE_CLAUDIAN_FIELDS.has('showToolUse')).toBe(false);
    });
  });

  describe('DEPRECATED_FIELDS', () => {
    it('contains all deprecated fields', () => {
      expect(DEPRECATED_FIELDS.has('allowedContextPaths')).toBe(true);
      expect(DEPRECATED_FIELDS.has('showToolUse')).toBe(true);
      expect(DEPRECATED_FIELDS.has('toolCallExpandedByDefault')).toBe(true);
    });
  });

  describe('convertEnvObjectToString', () => {
    it('converts simple env object to string', () => {
      const env = { API_KEY: 'secret123', MY_VAR: 'value' };
      const result = convertEnvObjectToString(env);

      expect(result).toBe('API_KEY=secret123\nMY_VAR=value');
    });

    it('handles empty object', () => {
      expect(convertEnvObjectToString({})).toBe('');
    });

    it('handles undefined input', () => {
      expect(convertEnvObjectToString(undefined)).toBe('');
    });

    it('handles null input', () => {
      expect(convertEnvObjectToString(null as any)).toBe('');
    });

    it('handles non-object input', () => {
      expect(convertEnvObjectToString('not an object' as any)).toBe('');
      expect(convertEnvObjectToString(123 as any)).toBe('');
      expect(convertEnvObjectToString(true as any)).toBe('');
    });

    it('handles numeric keys (converted to strings by JS)', () => {
      const env = { 123: 'value', valid: 'value' } as any;
      const result = convertEnvObjectToString(env);

      expect(result).toContain('123=value');
      expect(result).toContain('valid=value');
    });

    it('filters out non-string values', () => {
      const env = { string: 'value', number: 123, boolean: true, object: {} } as any;
      const result = convertEnvObjectToString(env);

      expect(result).toBe('string=value');
    });

    it('handles values with special characters', () => {
      const env = { KEY: 'value with spaces', KEY2: 'value=with=equals' };
      const result = convertEnvObjectToString(env);

      expect(result).toBe('KEY=value with spaces\nKEY2=value=with=equals');
    });

    it('handles values with newlines', () => {
      const env = { KEY: 'line1\nline2' };
      const result = convertEnvObjectToString(env);

      expect(result).toBe('KEY=line1\nline2');
    });

    it('handles unicode characters', () => {
      const env = { KEY: '🚀', KEY2: 'café' };
      const result = convertEnvObjectToString(env);

      expect(result).toBe('KEY=🚀\nKEY2=café');
    });

    it('handles very long values', () => {
      const longValue = 'a'.repeat(10000);
      const env = { LONG: longValue };
      const result = convertEnvObjectToString(env);

      expect(result).toBe(`LONG=${longValue}`);
    });

    it('handles multiple variables correctly', () => {
      const env = {
        ANTHROPIC_API_KEY: 'sk-ant-xxx',
        MODEL: 'claude-sonnet-4-5',
        THINKING_BUDGET: '20000',
      };
      const result = convertEnvObjectToString(env);

      expect(result).toContain('ANTHROPIC_API_KEY=sk-ant-xxx');
      expect(result).toContain('MODEL=claude-sonnet-4-5');
      expect(result).toContain('THINKING_BUDGET=20000');
    });

    it('maintains insertion order', () => {
      const env = { ZZZ: 'last', AAA: 'first', MMM: 'middle' };
      const result = convertEnvObjectToString(env);

      // ES2015+ guarantees string key insertion order
      expect(result).toBe('ZZZ=last\nAAA=first\nMMM=middle');
    });
  });

  describe('mergeEnvironmentVariables', () => {
    it('merges two env strings', () => {
      const existing = 'API_KEY=abc';
      const additional = 'MODEL=claude';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).toContain('API_KEY=abc');
      expect(result).toContain('MODEL=claude');
    });

    it('handles empty existing string', () => {
      const existing = '';
      const additional = 'KEY=value';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).toBe('KEY=value');
    });

    it('handles empty additional string', () => {
      const existing = 'KEY=value';
      const additional = '';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).toBe('KEY=value');
    });

    it('handles both empty strings', () => {
      expect(mergeEnvironmentVariables('', '')).toBe('');
    });

    it('allows additional to override existing values', () => {
      const existing = 'API_KEY=old\nMODEL=claude-3';
      const additional = 'API_KEY=new';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).toContain('API_KEY=new');
      expect(result).toContain('MODEL=claude-3');
      expect(result).not.toContain('API_KEY=old');
    });

    it('handles multiple same keys in same string', () => {
      const existing = 'KEY=first\nKEY=second';
      const additional = '';

      const result = mergeEnvironmentVariables(existing, additional);

      const keyValues = result.split('\n').filter(line => line.startsWith('KEY='));
      expect(keyValues).toHaveLength(1);
      expect(keyValues[0]).toBe('KEY=second');
    });

    it('handles comments (lines starting with #)', () => {
      const existing = '# Comment\nAPI_KEY=value';
      const additional = 'MODEL=claude';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).not.toContain('# Comment');
      expect(result).toContain('API_KEY=value');
      expect(result).toContain('MODEL=claude');
    });

    it('handles whitespace-only lines', () => {
      const existing = 'API_KEY=value\n   \nMODEL=claude';
      const additional = '';

      const result = mergeEnvironmentVariables(existing, additional);

      const lines = result.split('\n');
      expect(lines.every(line => line.trim() !== '')).toBe(true);
    });

    it('handles leading/trailing whitespace in lines', () => {
      const existing = '  API_KEY=value  \n  MODEL=claude  ';
      const additional = '';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).toContain('API_KEY=value');
      expect(result).toContain('MODEL=claude');
      const lines = result.split('\n');
      expect(lines.every(line => line === line.trim())).toBe(true);
    });

    it('handles empty values', () => {
      const existing = 'KEY1=\nKEY2=value2';
      const additional = '';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).toContain('KEY1=');
      expect(result).toContain('KEY2=value2');
    });

    it('handles values with equals signs', () => {
      const existing = 'KEY=value=with=equals';
      const additional = '';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).toBe('KEY=value=with=equals');
    });

    it('handles keys without values (empty after =)', () => {
      const existing = 'KEY=';
      const additional = '';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).toBe('KEY=');
    });

    it('handles lines without equals sign', () => {
      const existing = 'INVALID_LINE\nAPI_KEY=value';
      const additional = '';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).not.toContain('INVALID_LINE');
      expect(result).toContain('API_KEY=value');
    });

    it('handles equals at position 0', () => {
      const existing = '=invalid\nAPI_KEY=value';
      const additional = '';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).not.toContain('=invalid');
      expect(result).toContain('API_KEY=value');
    });

    it('handles multiline strings', () => {
      const existing = 'KEY1=value1\nKEY2=value2\nKEY3=value3';
      const additional = 'KEY4=value4\nKEY5=value5';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).toContain('KEY1=value1');
      expect(result).toContain('KEY2=value2');
      expect(result).toContain('KEY3=value3');
      expect(result).toContain('KEY4=value4');
      expect(result).toContain('KEY5=value5');
    });

    it('handles unicode in keys and values', () => {
      const existing = 'KÉY=vàlué1';
      const additional = 'KÉY=vàlué2';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).toContain('KÉY=vàlué2');
      expect(result).not.toContain('KÉY=vàlué1');
    });

    it('handles very long strings', () => {
      const longValue = 'a'.repeat(10000);
      const existing = `KEY1=${longValue}`;
      const additional = `KEY2=${longValue}`;

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).toContain(`KEY1=${longValue}`);
      expect(result).toContain(`KEY2=${longValue}`);
    });

    it('complex merge scenario', () => {
      const existing = `# API Configuration
ANTHROPIC_API_KEY=sk-ant-old
MODEL=claude-sonnet-3-5

# Feature flags
ENABLE_FEATURE=false`;
      const additional = `ANTHROPIC_API_KEY=sk-ant-new
ENABLE_FEATURE=true
NEW_FEATURE=true`;

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).toContain('ANTHROPIC_API_KEY=sk-ant-new');
      expect(result).toContain('MODEL=claude-sonnet-3-5');
      expect(result).toContain('ENABLE_FEATURE=true');
      expect(result).toContain('NEW_FEATURE=true');
      expect(result).not.toContain('sk-ant-old');
      expect(result).not.toContain('# API Configuration');
    });

    it('handles overlapping keys in both strings', () => {
      const existing = 'KEY=value1\nKEY2=value2';
      const additional = 'KEY=value3\nKEY2=value4';

      const result = mergeEnvironmentVariables(existing, additional);

      expect(result).toContain('KEY=value3');
      expect(result).toContain('KEY2=value4');
      expect(result).not.toContain('KEY=value1');
      expect(result).not.toContain('KEY2=value2');
    });

    it('handles duplicate keys in existing', () => {
      const existing = 'KEY=first\nKEY=second\nKEY=third';
      const additional = '';

      const result = mergeEnvironmentVariables(existing, additional);

      const keyCount = result.split('\n').filter(line => line.startsWith('KEY=')).length;
      expect(keyCount).toBe(1);
      expect(result).toContain('KEY=third');
    });

    it('handles duplicate keys in additional', () => {
      const existing = '';
      const additional = 'KEY=first\nKEY=second\nKEY=third';

      const result = mergeEnvironmentVariables(existing, additional);

      const keyCount = result.split('\n').filter(line => line.startsWith('KEY=')).length;
      expect(keyCount).toBe(1);
      expect(result).toContain('KEY=third');
    });
  });

  describe('integration scenarios', () => {
    it('converts and merges env objects', () => {
      const existingEnv = { API_KEY: 'old' };
      const additionalEnv = { API_KEY: 'new', MODEL: 'claude' };

      const existingStr = convertEnvObjectToString(existingEnv);
      const additionalStr = convertEnvObjectToString(additionalEnv);
      const merged = mergeEnvironmentVariables(existingStr, additionalStr);

      expect(merged).toContain('API_KEY=new');
      expect(merged).toContain('MODEL=claude');
      expect(merged).not.toContain('API_KEY=old');
    });

    it('handles real-world Claude Code environment migration', () => {
      const ccEnv = {
        ANTHROPIC_API_KEY: 'sk-ant-api-key',
        DEFAULT_MODEL: 'claude-sonnet-4-5',
        THINKING_BUDGET: '20000',
      };
      const claudianEnv = 'CLAUDE_CLI_PATH=/usr/local/bin/claude\nENABLE_FEATURE=true';

      const ccEnvStr = convertEnvObjectToString(ccEnv);
      const merged = mergeEnvironmentVariables(ccEnvStr, claudianEnv);

      expect(merged).toContain('ANTHROPIC_API_KEY=sk-ant-api-key');
      expect(merged).toContain('DEFAULT_MODEL=claude-sonnet-4-5');
      expect(merged).toContain('THINKING_BUDGET=20000');
      expect(merged).toContain('CLAUDE_CLI_PATH=/usr/local/bin/claude');
      expect(merged).toContain('ENABLE_FEATURE=true');
    });
  });
});
