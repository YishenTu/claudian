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

export function extractString(
  fm: Record<string, unknown>,
  key: string
): string | undefined {
  const val = fm[key];
  if (typeof val === 'string' && val.length > 0) return val;
  if (Array.isArray(val) && val.length > 0 && val.every(v => typeof v === 'string')) {
    return val.map(v => `[${v}]`).join(' ');
  }
  return undefined;
}

export function normalizeStringArray(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;

  if (Array.isArray(val)) {
    return val.map(v => String(v).trim()).filter(Boolean);
  }

  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return undefined;
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }

  return undefined;
}

export function extractStringArray(
  fm: Record<string, unknown>,
  key: string
): string[] | undefined {
  return normalizeStringArray(fm[key]);
}

export function extractBoolean(
  fm: Record<string, unknown>,
  key: string
): boolean | undefined {
  const val = fm[key];
  if (typeof val === 'boolean') return val;
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

const MAX_SLUG_LENGTH = 64;
const SLUG_PATTERN = /^[a-z0-9-]+$/;
const YAML_RESERVED_WORDS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off']);

export function validateSlugName(name: string, label: string): string | null {
  if (!name) {
    return `${label} name is required`;
  }
  if (name.length > MAX_SLUG_LENGTH) {
    return `${label} name must be ${MAX_SLUG_LENGTH} characters or fewer`;
  }
  if (!SLUG_PATTERN.test(name)) {
    return `${label} name can only contain lowercase letters, numbers, and hyphens`;
  }
  if (YAML_RESERVED_WORDS.has(name)) {
    return `${label} name cannot be a YAML reserved word (true, false, null, yes, no, on, off)`;
  }
  return null;
}
