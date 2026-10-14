import * as obsidian from 'obsidian';

import {
  parseFrontmatter,
} from '@/features/agent-skills/frontmatter';

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

  it('handles CRLF line endings', () => {
    const content = '---\r\nkey: value\r\n---\r\nBody';
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter).toEqual({ key: 'value' });
    expect(result!.body).toBe('Body');
  });

  it('handles empty frontmatter block', () => {
    jest.spyOn(obsidian, 'parseYaml').mockReturnValueOnce({});
    const content = `---

---
Body`;

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter).toEqual({});
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

  it('fallback parser handles multi-line arrays', () => {
    const content = `---
description: Use this agent when reviewing. Examples: Context: The user said something. user: hello
allowed-tools:
  - Read
  - Grep
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.description).toContain('Use this agent');
    expect(result!.frontmatter['allowed-tools']).toEqual(['Read', 'Grep']);
  });

  it('fallback parser unquotes quoted scalars', () => {
    const content = `---
description: "Value with: colon"
argument-hint: '[file] [focus]'
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.description).toBe('Value with: colon');
    expect(result!.frontmatter['argument-hint']).toBe('[file] [focus]');
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
