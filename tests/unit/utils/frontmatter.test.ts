import {
  extractBoolean,
  extractNumber,
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

describe('extractNumber', () => {
  it('extracts number', () => {
    expect(extractNumber({ count: 5 }, 'count')).toBe(5);
  });

  it('returns undefined for missing key', () => {
    expect(extractNumber({}, 'count')).toBeUndefined();
  });

  it('returns undefined for non-number', () => {
    expect(extractNumber({ count: 'five' }, 'count')).toBeUndefined();
  });

  it('returns undefined for NaN', () => {
    expect(extractNumber({ count: NaN }, 'count')).toBeUndefined();
  });
});
