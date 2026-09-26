import * as obsidian from 'obsidian';

import { extractFirstParagraph, parseSlashCommandContent, serializeCommand, serializeSlashCommandMarkdown, validateCommandName, yamlString } from '@/utils/slashCommand';

describe('parseSlashCommandContent', () => {
  describe('basic parsing', () => {
    it('should parse command with full frontmatter', () => {
      const content = `---
description: Review code for issues
argument-hint: "[file] [focus]"
allowed-tools:
  - Read
  - Grep
model: claude-sonnet-4-5
---
Review this code: $ARGUMENTS`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Review code for issues');
      expect(parsed.argumentHint).toBe('[file] [focus]');
      expect(parsed.allowedTools).toEqual(['Read', 'Grep']);
      expect(parsed.model).toBe('claude-sonnet-4-5');
      expect(parsed.promptContent).toBe('Review this code: $ARGUMENTS');
    });

    it('should parse command with minimal frontmatter', () => {
      const content = `---
description: Simple command
---
Do something`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Simple command');
      expect(parsed.argumentHint).toBeUndefined();
      expect(parsed.allowedTools).toBeUndefined();
      expect(parsed.model).toBeUndefined();
      expect(parsed.promptContent).toBe('Do something');
      expect(parsed.disableModelInvocation).toBeUndefined();
      expect(parsed.userInvocable).toBeUndefined();
      expect(parsed.context).toBeUndefined();
      expect(parsed.agent).toBeUndefined();
      expect(parsed.hooks).toBeUndefined();
    });

    it('should handle content without frontmatter', () => {
      const content = 'Just a prompt without frontmatter';

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBeUndefined();
      expect(parsed.promptContent).toBe('Just a prompt without frontmatter');
    });

    it('should handle inline array syntax for allowed-tools', () => {
      const content = `---
allowed-tools: [Read, Write, Bash]
---
Prompt`;

      const parsed = parseSlashCommandContent(content);
      expect(parsed.allowedTools).toEqual(['Read', 'Write', 'Bash']);
    });

    it('should handle quoted values', () => {
      const content = `---
description: "Value with: colon"
argument-hint: 'Single quoted'
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Value with: colon');
      expect(parsed.argumentHint).toBe('Single quoted');
    });
  });

  describe('Obsidian parsed-value mapping', () => {
    afterEach(() => jest.restoreAllMocks());

    it('preserves parsed multiline metadata and the original prompt body', () => {
      const parseYaml = jest.spyOn(obsidian, 'parseYaml').mockReturnValueOnce({
        description: '\nHello 世界\n  key: value | # content   \n\nÉmoji: 🎉  ',
        'argument-hint': '\n[task]\n  <notes>   \n',
        model: 'sonnet',
        'allowed-tools': ['Read', 'Write'],
      });
      const parsed = parseSlashCommandContent(
        '---\ndescription: from Obsidian\nargument-hint: from Obsidian\n---\nPrompt\nSecond line\n',
      );

      expect(parseYaml).toHaveBeenCalledTimes(1);
      expect(parseYaml).toHaveBeenCalledWith('description: from Obsidian\nargument-hint: from Obsidian');
      expect(parsed).toEqual({
        description: '\nHello 世界\n  key: value | # content   \n\nÉmoji: 🎉  ',
        argumentHint: '\n[task]\n  <notes>   \n',
        model: 'sonnet',
        allowedTools: ['Read', 'Write'],
        promptContent: 'Prompt\nSecond line\n',
        disableModelInvocation: undefined,
        userInvocable: undefined,
        context: undefined,
        agent: undefined,
        hooks: undefined,
      });
    });

    it('omits an empty parsed description while retaining other fields and body', () => {
      jest.spyOn(obsidian, 'parseYaml').mockReturnValueOnce({ description: '', model: 'sonnet' });

      const parsed = parseSlashCommandContent('---\ndescription: |\nmodel: sonnet\n---\nPrompt');

      expect(parsed.description).toBeUndefined();
      expect(parsed.model).toBe('sonnet');
      expect(parsed.promptContent).toBe('Prompt');
    });
  });

  describe('skill fields', () => {
    it('should parse kebab-case disable-model-invocation', () => {
      const content = `---
description: A skill
disable-model-invocation: true
---
Prompt`;

      const parsed = parseSlashCommandContent(content);
      expect(parsed.disableModelInvocation).toBe(true);
    });

    it('should parse kebab-case user-invocable', () => {
      const content = `---
description: A skill
user-invocable: false
---
Prompt`;

      const parsed = parseSlashCommandContent(content);
      expect(parsed.userInvocable).toBe(false);
    });

    it('ignores retired camelCase command fields', () => {
      const parsed = parseSlashCommandContent('---\nargumentHint: old\nallowedTools: [Read]\ndisableModelInvocation: true\nuserInvocable: false\n---\nPrompt');
      expect(parsed.argumentHint).toBeUndefined();
      expect(parsed.allowedTools).toBeUndefined();
      expect(parsed.disableModelInvocation).toBeUndefined();
      expect(parsed.userInvocable).toBeUndefined();
    });

    it('should prefer kebab-case over camelCase when both present', () => {
      const content = `---
disable-model-invocation: true
disableModelInvocation: false
user-invocable: false
userInvocable: true
---
Prompt`;

      const parsed = parseSlashCommandContent(content);
      expect(parsed.disableModelInvocation).toBe(true);
      expect(parsed.userInvocable).toBe(false);
    });

    it('should parse all skill fields together', () => {
      const content = `---
description: Full skill
disable-model-invocation: true
user-invocable: true
context: fork
agent: code-reviewer
model: sonnet
---
Do the thing`;

      const parsed = parseSlashCommandContent(content);
      expect(parsed.description).toBe('Full skill');
      expect(parsed.disableModelInvocation).toBe(true);
      expect(parsed.userInvocable).toBe(true);
      expect(parsed.context).toBe('fork');
      expect(parsed.agent).toBe('code-reviewer');
      expect(parsed.model).toBe('sonnet');
      expect(parsed.promptContent).toBe('Do the thing');
    });
  });
});

describe('yamlString', () => {
  it('returns plain value for simple strings', () => {
    expect(yamlString('hello world')).toBe('hello world');
  });

  it('quotes strings with colons', () => {
    expect(yamlString('key: value')).toBe('"key: value"');
  });

  it('quotes strings with hash', () => {
    expect(yamlString('has # comment')).toBe('"has # comment"');
  });

  it('quotes strings with newlines', () => {
    expect(yamlString('line1\nline2')).toBe('"line1\\nline2"');
  });

  it('quotes strings starting with space', () => {
    expect(yamlString(' leading')).toBe('" leading"');
  });

  it('quotes strings ending with space', () => {
    expect(yamlString('trailing ')).toBe('"trailing "');
  });

  it('escapes double quotes inside quoted strings', () => {
    expect(yamlString('has "quotes" inside: yes')).toBe('"has \\"quotes\\" inside: yes"');
  });

  it('escapes backslashes inside quoted strings', () => {
    expect(yamlString(String.raw`C:\Users\name: value`))
      .toBe('"C:\\\\Users\\\\name: value"');
  });
});

describe('serializeCommand', () => {
  it('strips frontmatter from content before serializing', () => {
    const result = serializeCommand({
      id: 'cmd-test',
      name: 'test',
      description: 'Test',
      content: '---\ndescription: old\n---\nBody text',
    });

    // Should use the SlashCommand's description, not the one in content frontmatter
    expect(result).toContain('description: Test');
    expect(result).toContain('Body text');
    expect(result).not.toContain('description: old');
  });

  it('handles content without frontmatter', () => {
    const result = serializeCommand({
      id: 'cmd-test',
      name: 'test',
      description: 'Simple',
      content: 'Just a prompt',
    });

    expect(result).toContain('description: Simple');
    expect(result).toContain('Just a prompt');
  });
});

describe('serializeSlashCommandMarkdown', () => {
  it('serializes all fields in kebab-case', () => {
    const result = serializeSlashCommandMarkdown({
      name: 'my-skill',
      description: 'Test command',
      argumentHint: '[file]',
      allowedTools: ['Read', 'Grep'],
      model: 'claude-sonnet-4-5',
      disableModelInvocation: true,
      userInvocable: false,
      context: 'fork',
      agent: 'code-reviewer',
    }, 'Do the thing');

    expect(result).toContain('name: my-skill');
    expect(result).toContain('description: Test command');
    expect(result).toContain('argument-hint: "[file]"');
    expect(result).toContain('allowed-tools:');
    expect(result).toContain('  - Read');
    expect(result).toContain('  - Grep');
    expect(result).toContain('model: claude-sonnet-4-5');
    expect(result).toContain('disable-model-invocation: true');
    expect(result).toContain('user-invocable: false');
    expect(result).toContain('context: fork');
    expect(result).toContain('agent: code-reviewer');
    expect(result).toContain('Do the thing');
  });

  it('omits undefined fields', () => {
    const result = serializeSlashCommandMarkdown({
      description: 'Minimal',
    }, 'Prompt');

    expect(result).toContain('description: Minimal');
    expect(result).not.toContain('name');
    expect(result).not.toContain('argument-hint');
    expect(result).not.toContain('allowed-tools');
    expect(result).not.toContain('model');
    expect(result).not.toContain('disable-model-invocation');
    expect(result).not.toContain('user-invocable');
    expect(result).not.toContain('context');
    expect(result).not.toContain('agent');
    expect(result).not.toContain('hooks');
  });

  it('serializes hooks as JSON', () => {
    const hooks = { PreToolUse: [{ matcher: 'Bash' }] };
    const result = serializeSlashCommandMarkdown({ hooks }, 'Prompt');
    expect(result).toContain(`hooks: ${JSON.stringify(hooks)}`);
  });

  it('produces valid frontmatter when no metadata exists', () => {
    const result = serializeSlashCommandMarkdown({}, 'Just a prompt');
    expect(result).toBe('---\n\n---\nJust a prompt');
  });

  it('round-trips through parse', () => {
    const serialized = serializeSlashCommandMarkdown({
      description: 'Round trip',
      disableModelInvocation: true,
      userInvocable: false,
      context: 'fork',
      agent: 'reviewer',
    }, 'Body text');

    const parsed = parseSlashCommandContent(serialized);
    expect(parsed.description).toBe('Round trip');
    expect(parsed.disableModelInvocation).toBe(true);
    expect(parsed.userInvocable).toBe(false);
    expect(parsed.context).toBe('fork');
    expect(parsed.agent).toBe('reviewer');
    expect(parsed.promptContent).toBe('Body text');
  });
});

describe('validateCommandName', () => {
  it('accepts valid lowercase names', () => {
    expect(validateCommandName('my-command')).toBeNull();
    expect(validateCommandName('test')).toBeNull();
    expect(validateCommandName('a')).toBeNull();
    expect(validateCommandName('abc123')).toBeNull();
    expect(validateCommandName('my-cmd-2')).toBeNull();
    expect(validateCommandName('a1b2c3')).toBeNull();
  });

  it('accepts name at exactly 64 characters', () => {
    const name = 'a'.repeat(64);
    expect(validateCommandName(name)).toBeNull();
  });

  it('rejects empty name', () => {
    expect(validateCommandName('')).not.toBeNull();
  });

  it('rejects uppercase letters', () => {
    expect(validateCommandName('MyCommand')).not.toBeNull();
    expect(validateCommandName('TEST')).not.toBeNull();
  });

  it('rejects underscores', () => {
    expect(validateCommandName('my_command')).not.toBeNull();
  });

  it('rejects slashes', () => {
    expect(validateCommandName('my/command')).not.toBeNull();
  });

  it('rejects spaces', () => {
    expect(validateCommandName('my command')).not.toBeNull();
  });

  it('rejects colons', () => {
    expect(validateCommandName('my:command')).not.toBeNull();
  });

  it('rejects names exceeding 64 characters', () => {
    const name = 'a'.repeat(65);
    expect(validateCommandName(name)).not.toBeNull();
  });

  it('rejects special characters', () => {
    expect(validateCommandName('cmd!@#')).not.toBeNull();
    expect(validateCommandName('cmd.test')).not.toBeNull();
  });

  it.each(['true', 'false', 'null', 'yes', 'no', 'on', 'off'])(
    'rejects YAML reserved word "%s"',
    (word) => {
      expect(validateCommandName(word)).not.toBeNull();
    }
  );
});

describe('extractFirstParagraph', () => {
  it('returns the first paragraph from multi-paragraph content', () => {
    expect(extractFirstParagraph('First paragraph.\n\nSecond paragraph.'))
      .toBe('First paragraph.');
  });

  it('returns single-line content as-is', () => {
    expect(extractFirstParagraph('Only one line')).toBe('Only one line');
  });

  it('collapses multi-line first paragraph into single line', () => {
    expect(extractFirstParagraph('Line one\nline two\n\nSecond paragraph'))
      .toBe('Line one line two');
  });

  it('returns undefined for empty content', () => {
    expect(extractFirstParagraph('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only content', () => {
    expect(extractFirstParagraph('   \n  \n  ')).toBeUndefined();
  });

  it('skips leading blank lines', () => {
    expect(extractFirstParagraph('\n\nActual first paragraph.\n\nSecond.'))
      .toBe('Actual first paragraph.');
  });
});
