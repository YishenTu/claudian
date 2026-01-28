import { parseYaml } from 'obsidian';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Fallback parser for YAML frontmatter that handles unquoted values with colons.
 * Extracts key-value pairs line by line, treating the first colon as the separator.
 */
function parseFrontmatterFallback(yamlContent: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlContent.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Find the first colon followed by a space (YAML key-value separator)
    const colonIndex = trimmed.indexOf(': ');
    if (colonIndex === -1) {
      // Try just colon at the end (empty value)
      if (trimmed.endsWith(':')) {
        const key = trimmed.slice(0, -1).trim();
        if (key && /^[\w-]+$/.test(key)) {
          result[key] = '';
        }
      }
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    let value: unknown = trimmed.slice(colonIndex + 2);

    // Only accept simple alphanumeric keys (avoid nested YAML confusion)
    if (!key || !/^[\w-]+$/.test(key)) continue;

    // Parse simple values
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === 'null' || value === '') value = null;
    else if (!isNaN(Number(value)) && value !== '') value = Number(value);
    // Handle arrays like [a, b, c]
    else if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    }

    result[key] = value;
  }

  return result;
}

export function parseFrontmatter(
  content: string
): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) return null;

  // Try strict YAML parsing first
  try {
    const parsed = parseYaml(match[1]);
    if (parsed !== null && parsed !== undefined && typeof parsed !== 'object') {
      return null;
    }
    return {
      frontmatter: (parsed as Record<string, unknown>) ?? {},
      body: match[2],
    };
  } catch {
    // Fallback to lenient line-by-line parsing
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

export function extractNumber(
  fm: Record<string, unknown>,
  key: string
): number | undefined {
  const val = fm[key];
  if (typeof val === 'number' && !isNaN(val)) return val;
  return undefined;
}
