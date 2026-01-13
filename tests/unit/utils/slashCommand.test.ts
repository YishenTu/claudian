/**
 * Slash command utilities tests.
 *
 * Tests for parseSlashCommandContent including YAML block scalar support.
 */

import { formatSlashCommandWarnings,parseSlashCommandContent } from '@/utils/slashCommand';

// ============================================================================
// formatSlashCommandWarnings Tests
// ============================================================================

describe('formatSlashCommandWarnings', () => {
  it('should format single warning', () => {
    const result = formatSlashCommandWarnings(['File not found']);
    expect(result).toBe('Slash command expansion warnings:\n- File not found');
  });

  it('should format multiple warnings up to max', () => {
    const result = formatSlashCommandWarnings(['Error 1', 'Error 2', 'Error 3']);
    expect(result).toBe('Slash command expansion warnings:\n- Error 1\n- Error 2\n- Error 3');
  });

  it('should truncate with count when exceeding max', () => {
    const result = formatSlashCommandWarnings(['Error 1', 'Error 2', 'Error 3', 'Error 4', 'Error 5']);
    expect(result).toBe('Slash command expansion warnings:\n- Error 1\n- Error 2\n- Error 3\n...and 2 more');
  });
});

// ============================================================================
// parseSlashCommandContent Tests
// ============================================================================

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

      // Empty block scalar should result in empty string, not consume next field
      expect(parsed.description).toBe('');
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
});
