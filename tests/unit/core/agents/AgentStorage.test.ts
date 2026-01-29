import { buildAgentFromFrontmatter, parseAgentFile, parseModel, parsePermissionMode, parseToolsList } from '@/core/agents/AgentStorage';

describe('parseAgentFile', () => {
  it('parses valid frontmatter and body', () => {
    const content = `---
name: TestAgent
description: Handles tests
tools: [Read, Grep]
disallowedTools: [Write]
model: sonnet
---
You are helpful.`;

    const parsed = parseAgentFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.name).toBe('TestAgent');
    expect(parsed?.frontmatter.description).toBe('Handles tests');
    expect(parsed?.frontmatter.tools).toEqual(['Read', 'Grep']);
    expect(parsed?.frontmatter.disallowedTools).toEqual(['Write']);
    expect(parsed?.frontmatter.model).toBe('sonnet');
    expect(parsed?.body).toBe('You are helpful.');
  });

  it('rejects non-string name', () => {
    const content = `---
name: [NotAString]
description: Valid description
---
Body.`;

    expect(parseAgentFile(content)).toBeNull();
  });

  it('rejects non-string description', () => {
    const content = `---
name: ValidName
description: [NotAString]
---
Body.`;

    expect(parseAgentFile(content)).toBeNull();
  });

  it('rejects invalid tools type', () => {
    const content = `---
name: ValidName
description: Valid description
tools: true
---
Body.`;

    expect(parseAgentFile(content)).toBeNull();
  });

  it('rejects invalid disallowedTools type', () => {
    const content = `---
name: ValidName
description: Valid description
disallowedTools: 123
---
Body.`;

    expect(parseAgentFile(content)).toBeNull();
  });

  it('returns null for content without frontmatter', () => {
    const content = 'Just some text without frontmatter';
    expect(parseAgentFile(content)).toBeNull();
  });

  it('returns null for incomplete frontmatter markers', () => {
    const content = `---
name: TestAgent
description: Test
Body without closing markers.`;
    expect(parseAgentFile(content)).toBeNull();
  });

  it('returns null for missing required name field', () => {
    const content = `---
description: Valid description
---
Body.`;
    expect(parseAgentFile(content)).toBeNull();
  });

  it('returns null for missing required description field', () => {
    const content = `---
name: ValidName
---
Body.`;
    expect(parseAgentFile(content)).toBeNull();
  });

  it('returns null for empty name', () => {
    const content = `---
name:
description: Valid description
---
Body.`;
    expect(parseAgentFile(content)).toBeNull();
  });

  it('returns null for empty description', () => {
    const content = `---
name: ValidName
description:
---
Body.`;
    expect(parseAgentFile(content)).toBeNull();
  });

  it('accepts tools as comma-separated string', () => {
    const content = `---
name: TestAgent
description: Test agent
tools: Read, Grep, Glob
---
Body.`;

    const parsed = parseAgentFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.tools).toBe('Read, Grep, Glob');
  });

  it('parses skills array', () => {
    const content = `---
name: TestAgent
description: Test agent
skills: [my-skill, another-skill]
---
Body.`;

    const parsed = parseAgentFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.skills).toEqual(['my-skill', 'another-skill']);
  });

  it('returns undefined for missing optional fields', () => {
    const content = `---
name: TestAgent
description: Test agent
---
Body.`;

    const parsed = parseAgentFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.skills).toBeUndefined();
  });

  it('parses permissionMode from frontmatter', () => {
    const content = `---
name: TestAgent
description: Test agent
permissionMode: dontAsk
---
Body.`;

    const parsed = parseAgentFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.permissionMode).toBe('dontAsk');
  });

  it('returns undefined permissionMode when not set', () => {
    const content = `---
name: TestAgent
description: Test agent
---
Body.`;

    const parsed = parseAgentFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.permissionMode).toBeUndefined();
  });

  it('returns undefined hooks when not set', () => {
    const content = `---
name: TestAgent
description: Test agent
---
Body.`;

    const parsed = parseAgentFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.hooks).toBeUndefined();
  });

  it('collects unknown frontmatter keys into extraFrontmatter', () => {
    const content = `---
name: TestAgent
description: Test agent
maxTurns: 10
customKey: hello
---
Body.`;

    const parsed = parseAgentFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.extraFrontmatter).toEqual({
      maxTurns: 10,
      customKey: 'hello',
    });
  });

  it('sets extraFrontmatter to undefined when no unknown keys', () => {
    const content = `---
name: TestAgent
description: Test agent
---
Body.`;

    const parsed = parseAgentFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.extraFrontmatter).toBeUndefined();
  });

  it('ignores non-object hooks values', () => {
    const content = `---
name: TestAgent
description: Test agent
hooks: not-an-object
---
Body.`;

    const parsed = parseAgentFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.hooks).toBeUndefined();
  });
});

describe('parseToolsList', () => {
  it('returns undefined for undefined input', () => {
    expect(parseToolsList(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseToolsList('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(parseToolsList('   ')).toBeUndefined();
  });

  it('parses comma-separated string into array', () => {
    expect(parseToolsList('Read, Grep, Glob')).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('trims whitespace from tool names', () => {
    expect(parseToolsList('  Read  ,  Grep  ')).toEqual(['Read', 'Grep']);
  });

  it('filters out empty entries from comma-separated string', () => {
    expect(parseToolsList('Read,,Grep,')).toEqual(['Read', 'Grep']);
  });

  it('returns empty array for empty array input', () => {
    expect(parseToolsList([])).toEqual([]);
  });

  it('returns array as-is when already an array', () => {
    expect(parseToolsList(['Read', 'Grep'])).toEqual(['Read', 'Grep']);
  });

  it('trims and filters array elements', () => {
    expect(parseToolsList(['  Read  ', '', '  Grep  ', ''])).toEqual(['Read', 'Grep']);
  });

  it('converts non-string array elements to strings', () => {
    // Edge case: if someone passes numbers in YAML array
    expect(parseToolsList([123 as unknown as string, 'Read'])).toEqual(['123', 'Read']);
  });

  it('handles single tool in string format', () => {
    expect(parseToolsList('Read')).toEqual(['Read']);
  });

  it('handles single tool in array format', () => {
    expect(parseToolsList(['Read'])).toEqual(['Read']);
  });
});

describe('parseModel', () => {
  it('returns inherit for undefined input', () => {
    expect(parseModel(undefined)).toBe('inherit');
  });

  it('returns inherit for empty string', () => {
    expect(parseModel('')).toBe('inherit');
  });

  it('returns sonnet for valid sonnet input', () => {
    expect(parseModel('sonnet')).toBe('sonnet');
  });

  it('returns opus for valid opus input', () => {
    expect(parseModel('opus')).toBe('opus');
  });

  it('returns haiku for valid haiku input', () => {
    expect(parseModel('haiku')).toBe('haiku');
  });

  it('returns inherit for valid inherit input', () => {
    expect(parseModel('inherit')).toBe('inherit');
  });

  it('is case-insensitive', () => {
    expect(parseModel('SONNET')).toBe('sonnet');
    expect(parseModel('Opus')).toBe('opus');
    expect(parseModel('HAIKU')).toBe('haiku');
    expect(parseModel('INHERIT')).toBe('inherit');
  });

  it('trims whitespace', () => {
    expect(parseModel('  sonnet  ')).toBe('sonnet');
  });

  it('returns inherit for invalid model value', () => {
    expect(parseModel('claude-3')).toBe('inherit');
    expect(parseModel('gpt-4')).toBe('inherit');
    expect(parseModel('invalid')).toBe('inherit');
  });
});

describe('parsePermissionMode', () => {
  it('returns undefined for undefined input', () => {
    expect(parsePermissionMode(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parsePermissionMode('')).toBeUndefined();
  });

  it('returns default for valid default input', () => {
    expect(parsePermissionMode('default')).toBe('default');
  });

  it('returns acceptEdits for valid input', () => {
    expect(parsePermissionMode('acceptEdits')).toBe('acceptEdits');
  });

  it('returns dontAsk for valid input', () => {
    expect(parsePermissionMode('dontAsk')).toBe('dontAsk');
  });

  it('returns bypassPermissions for valid input', () => {
    expect(parsePermissionMode('bypassPermissions')).toBe('bypassPermissions');
  });

  it('returns plan for valid input', () => {
    expect(parsePermissionMode('plan')).toBe('plan');
  });

  it('returns delegate for valid input', () => {
    expect(parsePermissionMode('delegate')).toBe('delegate');
  });

  it('returns undefined for invalid value', () => {
    expect(parsePermissionMode('invalid')).toBeUndefined();
    expect(parsePermissionMode('DONTASK')).toBeUndefined();
    expect(parsePermissionMode('dont-ask')).toBeUndefined();
  });

  it('trims whitespace', () => {
    expect(parsePermissionMode('  dontAsk  ')).toBe('dontAsk');
  });
});

describe('buildAgentFromFrontmatter', () => {
  it('maps all frontmatter fields to AgentDefinition', () => {
    const result = buildAgentFromFrontmatter(
      {
        name: 'Test',
        description: 'A test agent',
        tools: ['Read', 'Grep'],
        disallowedTools: ['Bash'],
        model: 'opus',
        skills: ['my-skill'],
        permissionMode: 'dontAsk',
        hooks: { preToolUse: { command: 'echo hi' } },
      },
      'You are helpful.',
      { id: 'test', source: 'vault', filePath: '/path/to/test.md' }
    );

    expect(result.id).toBe('test');
    expect(result.name).toBe('Test');
    expect(result.description).toBe('A test agent');
    expect(result.prompt).toBe('You are helpful.');
    expect(result.tools).toEqual(['Read', 'Grep']);
    expect(result.disallowedTools).toEqual(['Bash']);
    expect(result.model).toBe('opus');
    expect(result.source).toBe('vault');
    expect(result.filePath).toBe('/path/to/test.md');
    expect(result.skills).toEqual(['my-skill']);
    expect(result.permissionMode).toBe('dontAsk');
    expect(result.hooks).toEqual({ preToolUse: { command: 'echo hi' } });
  });

  it('propagates pluginName from meta', () => {
    const result = buildAgentFromFrontmatter(
      { name: 'PluginAgent', description: 'From plugin' },
      'Prompt.',
      { id: 'my-plugin:agent', source: 'plugin', pluginName: 'my-plugin' }
    );

    expect(result.pluginName).toBe('my-plugin');
    expect(result.source).toBe('plugin');
  });

  it('defaults model to inherit for invalid value', () => {
    const result = buildAgentFromFrontmatter(
      { name: 'Test', description: 'Desc', model: 'gpt-4' },
      'Prompt.',
      { id: 'test', source: 'vault' }
    );

    expect(result.model).toBe('inherit');
  });

  it('returns undefined permissionMode for invalid value', () => {
    const result = buildAgentFromFrontmatter(
      { name: 'Test', description: 'Desc', permissionMode: 'INVALID' },
      'Prompt.',
      { id: 'test', source: 'vault' }
    );

    expect(result.permissionMode).toBeUndefined();
  });
});
