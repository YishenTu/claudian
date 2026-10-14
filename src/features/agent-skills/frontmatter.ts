import { parseYaml } from 'obsidian';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const VALID_KEY_PATTERN = /^[\w-]+$/;

function isValidKey(key: string): boolean {
  return key.length > 0 && VALID_KEY_PATTERN.test(key);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseScalarValue(rawValue: string): unknown {
  const value = rawValue.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '') return null;
  if (!Number.isNaN(Number(value))) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => unquote(item));
  }
  return unquote(value);
}

/** Handles malformed YAML (e.g. unquoted values with colons) by line-by-line key:value extraction. */
function parseFrontmatterFallback(yamlContent: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlContent.split(/\r?\n/);
  let currentListKey: string | null = null;
  let currentList: unknown[] = [];

  function flushList(): void {
    if (!currentListKey) return;
    result[currentListKey] = currentList;
    currentListKey = null;
    currentList = [];
  }

  let pendingBareKey: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (currentListKey) {
      if (trimmed.startsWith('- ')) {
        currentList.push(parseScalarValue(trimmed.slice(2)));
        continue;
      }
      flushList();
    }

    if (pendingBareKey) {
      if (trimmed.startsWith('- ')) {
        currentListKey = pendingBareKey;
        currentList = [];
        pendingBareKey = null;
        currentList.push(parseScalarValue(trimmed.slice(2)));
        continue;
      }
      result[pendingBareKey] = '';
      pendingBareKey = null;
    }

    const colonIndex = trimmed.indexOf(': ');
    if (colonIndex === -1) {
      if (trimmed.endsWith(':')) {
        const key = trimmed.slice(0, -1).trim();
        if (isValidKey(key)) {
          pendingBareKey = key;
        }
      }
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    if (!isValidKey(key)) continue;
    result[key] = parseScalarValue(trimmed.slice(colonIndex + 2));
  }

  if (pendingBareKey) {
    result[pendingBareKey] = '';
  }

  flushList();
  return result;
}

export function parseFrontmatter(
  content: string
): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) return null;

  try {
    const parsed: unknown = parseYaml(match[1]);
    if (parsed !== null && parsed !== undefined && typeof parsed !== 'object') {
      return null;
    }
    return {
      frontmatter: (parsed as Record<string, unknown>) ?? {},
      body: match[2],
    };
  } catch {
    const fallbackParsed = parseFrontmatterFallback(match[1]);
    if (Object.keys(fallbackParsed).length > 0) {
      return {
        frontmatter: fallbackParsed,
        body: match[2],
      };
    }
    return null;
  }
}
