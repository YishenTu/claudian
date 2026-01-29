import * as obsidian from 'obsidian';

import {
  extractBoolean,
  extractString,
  extractStringArray,
  normalizeStringArray,
  parseFrontmatter,
} from '@/utils/frontmatter';

describe('parseFrontmatter', () => {
  it('parses valid frontmatter with body', () => {
    const content = `---
title: Hello
---
Body text here`;

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter).toEqual({ title: 'Hello' });
    expect(result!.body).toBe('Body text here');
  });

  it('returns null for content without frontmatter', () => {
    expect(parseFrontmatter('Just text')).toBeNull();
  });

  it('handles empty body', () => {
    const content = `---
key: value
---
`;

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter).toEqual({ key: 'value' });
    expect(result!.body).toBe('');
  });

  it('returns result with empty frontmatter for unrecognized YAML content', () => {
    const content = `---
: invalid yaml [{{
---
Body`;

    // Mock parseYaml doesn't throw — returns empty object for unrecognized content.
    // In production, Obsidian's parseYaml may throw, which parseFrontmatter catches.
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter).toEqual({});
    expect(result!.body).toBe('Body');
  });

  it('handles CRLF line endings', () => {
    const content = '---\r\nkey: value\r\n---\r\nBody';
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter).toEqual({ key: 'value' });
    expect(result!.body).toBe('Body');
  });

  it('handles empty frontmatter block', () => {
    const content = `---

---
Body`;

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    // parseYaml returns null for empty string
    expect(result!.body).toBe('Body');
  });

  it('parses complex YAML values', () => {
    const content = `---
description: "Value with: colon"
tools:
  - Read
  - Grep
model: sonnet
enabled: true
count: 5
---
Prompt`;

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.description).toBe('Value with: colon');
    expect(result!.frontmatter.tools).toEqual(['Read', 'Grep']);
    expect(result!.frontmatter.model).toBe('sonnet');
    expect(result!.frontmatter.enabled).toBe(true);
    expect(result!.frontmatter.count).toBe(5);
    expect(result!.body).toBe('Prompt');
  });

  it('falls back to lenient parsing when YAML has unquoted colons', () => {
    // This mimics pr-review-toolkit agents with unquoted descriptions containing colons
    const content = `---
name: code-reviewer
description: Use this agent when reviewing. Examples: Context: The user said something. user: hello
model: opus
---
You are a code reviewer.`;

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.name).toBe('code-reviewer');
    // Fallback parser takes first colon-space as separator, so description includes the rest
    expect(result!.frontmatter.description).toContain('Use this agent');
    expect(result!.frontmatter.model).toBe('opus');
    expect(result!.body).toBe('You are a code reviewer.');
  });

  it('fallback parser handles inline arrays', () => {
    const content = `---
name: test-agent
description: A test agent
tools: [Read, Grep, Glob]
---
Body`;

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.name).toBe('test-agent');
    expect(result!.frontmatter.tools).toEqual(['Read', 'Grep', 'Glob']);
  });
});

describe('extractString', () => {
  it('extracts string value', () => {
    expect(extractString({ key: 'hello' }, 'key')).toBe('hello');
  });

  it('returns undefined for missing key', () => {
    expect(extractString({}, 'key')).toBeUndefined();
  });

  it('returns undefined for non-string value', () => {
    expect(extractString({ key: 123 }, 'key')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractString({ key: '' }, 'key')).toBeUndefined();
  });
});

describe('extractStringArray', () => {
  it('extracts YAML array', () => {
    expect(extractStringArray({ tools: ['Read', 'Grep'] }, 'tools'))
      .toEqual(['Read', 'Grep']);
  });

  it('splits comma-separated string', () => {
    expect(extractStringArray({ tools: 'Read, Grep, Glob' }, 'tools'))
      .toEqual(['Read', 'Grep', 'Glob']);
  });

  it('wraps single string in array', () => {
    expect(extractStringArray({ tools: 'Read' }, 'tools'))
      .toEqual(['Read']);
  });

  it('returns undefined for missing key', () => {
    expect(extractStringArray({}, 'tools')).toBeUndefined();
  });

  it('returns undefined for non-string/array value', () => {
    expect(extractStringArray({ tools: 123 }, 'tools')).toBeUndefined();
  });

  it('filters empty entries from comma-separated string', () => {
    expect(extractStringArray({ tools: 'Read,,Grep,' }, 'tools'))
      .toEqual(['Read', 'Grep']);
  });

  it('converts non-string array elements to strings', () => {
    expect(extractStringArray({ tools: [123, 'Read'] }, 'tools'))
      .toEqual(['123', 'Read']);
  });
});

describe('normalizeStringArray', () => {
  it('returns undefined for undefined', () => {
    expect(normalizeStringArray(undefined)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(normalizeStringArray(null)).toBeUndefined();
  });

  it('normalizes array of strings', () => {
    expect(normalizeStringArray(['Read', 'Grep'])).toEqual(['Read', 'Grep']);
  });

  it('trims and filters array elements', () => {
    expect(normalizeStringArray(['  Read  ', '', '  Grep  ', ''])).toEqual(['Read', 'Grep']);
  });

  it('converts non-string array elements to strings', () => {
    expect(normalizeStringArray([123, 'Read'])).toEqual(['123', 'Read']);
  });

  it('splits comma-separated string', () => {
    expect(normalizeStringArray('Read, Grep, Glob')).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('wraps single string in array', () => {
    expect(normalizeStringArray('Read')).toEqual(['Read']);
  });

  it('returns undefined for empty string', () => {
    expect(normalizeStringArray('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(normalizeStringArray('   ')).toBeUndefined();
  });

  it('filters empty entries from comma-separated string', () => {
    expect(normalizeStringArray('Read,,Grep,')).toEqual(['Read', 'Grep']);
  });

  it('returns undefined for non-string/array types', () => {
    expect(normalizeStringArray(123)).toBeUndefined();
    expect(normalizeStringArray(true)).toBeUndefined();
  });
});

describe('extractBoolean', () => {
  it('extracts true', () => {
    expect(extractBoolean({ flag: true }, 'flag')).toBe(true);
  });

  it('extracts false', () => {
    expect(extractBoolean({ flag: false }, 'flag')).toBe(false);
  });

  it('returns undefined for missing key', () => {
    expect(extractBoolean({}, 'flag')).toBeUndefined();
  });

  it('returns undefined for non-boolean', () => {
    expect(extractBoolean({ flag: 'yes' }, 'flag')).toBeUndefined();
  });
});

describe('parseFrontmatter non-object return', () => {
  it('returns null when parseYaml returns a string', () => {
    jest.spyOn(obsidian, 'parseYaml').mockReturnValueOnce('just a string' as any);
    const content = `---
just a string
---
Body`;
    expect(parseFrontmatter(content)).toBeNull();
  });

  it('returns null when parseYaml returns a number', () => {
    jest.spyOn(obsidian, 'parseYaml').mockReturnValueOnce(42 as any);
    const content = `---
42
---
Body`;
    expect(parseFrontmatter(content)).toBeNull();
  });
});

describe('parseFrontmatter fallback parser', () => {
  beforeEach(() => {
    jest.spyOn(obsidian, 'parseYaml').mockImplementation(() => {
      throw new Error('YAML parse error');
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('falls back to line-by-line parsing when parseYaml throws', () => {
    const content = `---
name: test
model: opus
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.name).toBe('test');
    expect(result!.frontmatter.model).toBe('opus');
    expect(result!.body).toBe('Body');
  });

  it('fallback parser handles boolean coercion', () => {
    const content = `---
enabled: true
disabled: false
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.enabled).toBe(true);
    expect(result!.frontmatter.disabled).toBe(false);
  });

  it('fallback parser handles null and empty values', () => {
    const content = `---
empty: null
blank:
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.empty).toBeNull();
    // Trailing colon with no `: ` separator sets value to empty string
    expect(result!.frontmatter.blank).toBe('');
  });

  it('fallback parser handles number coercion', () => {
    const content = `---
count: 42
ratio: 3.14
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.count).toBe(42);
    expect(result!.frontmatter.ratio).toBe(3.14);
  });

  it('fallback parser handles inline arrays', () => {
    const content = `---
tools: [Read, Grep, Glob]
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.tools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('fallback parser skips comment lines', () => {
    const content = `---
# This is a comment
name: test
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter).not.toHaveProperty('#');
    expect(result!.frontmatter.name).toBe('test');
  });

  it('fallback parser skips empty lines', () => {
    const content = `---
name: test

model: opus
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.name).toBe('test');
    expect(result!.frontmatter.model).toBe('opus');
  });

  it('fallback parser handles keys with trailing colon only', () => {
    const content = `---
emptykey:
name: test
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.emptykey).toBe('');
    expect(result!.frontmatter.name).toBe('test');
  });

  it('fallback parser rejects invalid key names', () => {
    const content = `---
valid-key: value
invalid key: value
123start: value
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter['valid-key']).toBe('value');
    expect(result!.frontmatter['123start']).toBe('value');
    expect(result!.frontmatter).not.toHaveProperty('invalid key');
  });

  it('fallback parser handles string values with colons', () => {
    const content = `---
description: Use this: for reviewing
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.description).toBe('Use this: for reviewing');
  });

  it('returns null when fallback parser finds no valid keys', () => {
    const content = `---
invalid key with spaces: value
another bad key!: value
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).toBeNull();
  });
});
