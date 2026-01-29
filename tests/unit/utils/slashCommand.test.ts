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

  describe('block scalar support', () => {
    it('should parse literal block scalar (|) for description', () => {
      const content = `---
description: |
  Records a checkpoint of progress in the daily note.
  Includes timestamp and current task status.
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Records a checkpoint of progress in the daily note.\nIncludes timestamp and current task status.');
      expect(parsed.promptContent).toBe('Prompt');
    });

    it('should parse folded block scalar (>) for description', () => {
      const content = `---
description: >
  Records a checkpoint of progress
  in the daily note.
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Records a checkpoint of progress in the daily note.');
      expect(parsed.promptContent).toBe('Prompt');
    });

    it('should produce different output for | vs > block scalars', () => {
      const literalContent = `---
description: |
  Line one
  Line two
---
Prompt`;
      const foldedContent = `---
description: >
  Line one
  Line two
---
Prompt`;

      const literal = parseSlashCommandContent(literalContent);
      const folded = parseSlashCommandContent(foldedContent);

      expect(literal.description).toBe('Line one\nLine two');
      expect(folded.description).toBe('Line one Line two');
      expect(literal.description).not.toBe(folded.description);
    });

    it('should preserve paragraph breaks in folded block scalar (>)', () => {
      const content = `---
description: >
  First paragraph here.

  Second paragraph after empty line.
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('First paragraph here.\n\nSecond paragraph after empty line.');
      expect(parsed.promptContent).toBe('Prompt');
    });

    it('should parse literal block scalar for argument-hint', () => {
      const content = `---
argument-hint: |
  [task-name]
  [optional-notes]
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.argumentHint).toBe('[task-name]\n[optional-notes]');
    });

    it('should handle empty lines in literal block scalar', () => {
      const content = `---
description: |
  First paragraph here.

  Second paragraph after empty line.
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('First paragraph here.\n\nSecond paragraph after empty line.');
    });

    it('should parse block scalar with other fields', () => {
      const content = `---
description: |
  Multi-line description
  with multiple lines
model: claude-sonnet-4-5
allowed-tools:
  - Read
  - Write
---
Prompt content`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Multi-line description\nwith multiple lines');
      expect(parsed.model).toBe('claude-sonnet-4-5');
      expect(parsed.allowedTools).toEqual(['Read', 'Write']);
      expect(parsed.promptContent).toBe('Prompt content');
    });

    it('should handle block scalar at end of frontmatter', () => {
      const content = `---
model: claude-haiku-4-5
description: |
  Last field in frontmatter
  with multiple lines
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Last field in frontmatter\nwith multiple lines');
      expect(parsed.model).toBe('claude-haiku-4-5');
    });

    it('should preserve indentation within block scalar content', () => {
      const content = `---
description: |
  Code example:
    - Step 1
    - Step 2
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Code example:\n  - Step 1\n  - Step 2');
    });

    it('should handle single-line block scalar', () => {
      const content = `---
description: |
  Just one line
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Just one line');
    });

    it('should not confuse pipe in quoted string with block scalar', () => {
      const content = `---
description: "Contains | pipe character"
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Contains | pipe character');
    });

    it('should handle multiple block scalars in same frontmatter', () => {
      const content = `---
description: |
  First block scalar
  with multiple lines
argument-hint: |
  Second block scalar
  also multi-line
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('First block scalar\nwith multiple lines');
      expect(parsed.argumentHint).toBe('Second block scalar\nalso multi-line');
    });

    it('should handle CRLF line endings in block scalar', () => {
      const content = '---\r\ndescription: |\r\n  Line one\r\n  Line two\r\n---\r\nPrompt';

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Line one\nLine two');
      expect(parsed.promptContent).toBe('Prompt');
    });
  });

  describe('block scalar edge cases', () => {
    it('should handle empty block scalar followed by another field', () => {
      const content = `---
description: |
model: claude-sonnet-4-5
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      // Empty block scalar yields no description (semantically same as absent)
      expect(parsed.description).toBeUndefined();
      expect(parsed.model).toBe('claude-sonnet-4-5');
    });

    it('should handle block scalar with only empty lines before next field', () => {
      const content = `---
description: |

model: claude-sonnet-4-5
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      // Empty lines followed by unindented field should end the block scalar
      expect(parsed.model).toBe('claude-sonnet-4-5');
    });

    it('should handle strip chomping indicator (|-)', () => {
      const content = `---
description: |-
  No trailing newline here
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      // Chomping indicator is recognized and parsed as block scalar
      expect(parsed.description).toBe('No trailing newline here');
    });

    it('should handle keep chomping indicator (|+)', () => {
      const content = `---
description: |+
  Keep indicator recognized
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      // Keep chomping indicator is recognized
      expect(parsed.description).toBe('Keep indicator recognized');
    });

    it('should handle folded with strip chomping (>-)', () => {
      const content = `---
description: >-
  Folded with strip
  chomping indicator
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Folded with strip chomping indicator');
    });

    it('should not enable block scalar for unsupported keys', () => {
      const content = `---
notes: |
  This should not be parsed as block scalar
description: Regular description
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      // notes is not a supported key, so | is treated as the value
      // description should be parsed normally
      expect(parsed.description).toBe('Regular description');
    });

    it('should handle allowed-tools with block scalar indicator gracefully', () => {
      const content = `---
allowed-tools: |
  Read
  Write
description: Test
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      // allowed-tools doesn't support block scalar, so | becomes the value
      // The Read/Write lines are ignored as they're not valid YAML keys
      expect(parsed.description).toBe('Test');
    });

    it('should preserve unicode content in block scalar', () => {
      const content = `---
description: |
  Hello 世界
  Émoji: 🎉
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Hello 世界\nÉmoji: 🎉');
    });

    it('should preserve relative indentation in deeply nested content', () => {
      const content = `---
description: |
  Level 1
    Level 2
      Level 3
        Level 4
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Level 1\n  Level 2\n    Level 3\n      Level 4');
    });

    it('should preserve colons in block scalar content', () => {
      const content = `---
description: |
  key: value
  another: pair
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('key: value\nanother: pair');
    });

    it('should preserve comment-like content (# lines)', () => {
      const content = `---
description: |
  # This looks like a YAML comment
  But it is preserved as content
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('# This looks like a YAML comment\nBut it is preserved as content');
    });

    it('should preserve trailing whitespace in block scalar lines', () => {
      // Use explicit string to ensure trailing spaces are preserved
      const content = '---\ndescription: |\n  Line with trailing spaces   \n  Normal line\n---\nPrompt';

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Line with trailing spaces   \nNormal line');
    });

    it('should preserve leading empty lines in block scalar', () => {
      const content = `---
description: |

  Content after empty line
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      // Leading empty lines are preserved per YAML spec
      expect(parsed.description).toBe('\nContent after empty line');
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

    it('should parse camelCase disableModelInvocation (backwards compat)', () => {
      const content = `---
description: A skill
disableModelInvocation: true
---
Prompt`;

      const parsed = parseSlashCommandContent(content);
      expect(parsed.disableModelInvocation).toBe(true);
    });

    it('should parse camelCase userInvocable (backwards compat)', () => {
      const content = `---
description: A skill
userInvocable: false
---
Prompt`;

      const parsed = parseSlashCommandContent(content);
      expect(parsed.userInvocable).toBe(false);
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

    it('should parse context string', () => {
      const content = `---
description: A skill
context: fork
---
Prompt`;

      const parsed = parseSlashCommandContent(content);
      expect(parsed.context).toBe('fork');
    });

    it('should parse agent string', () => {
      const content = `---
description: A skill
agent: code-reviewer
---
Prompt`;

      const parsed = parseSlashCommandContent(content);
      expect(parsed.agent).toBe('code-reviewer');
    });

    it('should parse all skill fields together', () => {
      const content = `---
description: Full skill
disableModelInvocation: true
userInvocable: true
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

    it('should return undefined for missing skill fields', () => {
      const content = `---
description: Simple command
---
Prompt`;

      const parsed = parseSlashCommandContent(content);
      expect(parsed.disableModelInvocation).toBeUndefined();
      expect(parsed.userInvocable).toBeUndefined();
      expect(parsed.context).toBeUndefined();
      expect(parsed.agent).toBeUndefined();
      expect(parsed.hooks).toBeUndefined();
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
    expect(yamlString('line1\nline2')).toBe('"line1\nline2"');
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
    expect(result).toContain('argument-hint: [file]');
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
