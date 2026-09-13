export type LinkedContentPathSource =
  | 'canonical'
  | 'legacy'
  | 'absent'
  | 'invalid';

export interface LinkedContentPathDecodeResult {
  path: string | undefined;
  needsMigration: boolean;
  source: LinkedContentPathSource;
}

const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATTERN = /^(?:\\\\|\/\/)/;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

// Exact entity set produced by escapePromptXmlAttribute (src/utils/promptXml.ts).
// Escaped values must never survive normalization as literal path text: the
// rendered prompt attribute is the only path signal the agent sees, so it can
// copy the escaped form into file operations (issue #1230). Single pass, one
// level only.
const ESCAPED_ENTITY_PATTERN = /&(?:amp|quot|lt|gt|#9|#10|#13);/g;

const ENTITY_DECODE: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&lt;': '<',
  '&gt;': '>',
  '&#9;': '\t',
  '&#10;': '\n',
  '&#13;': '\r',
};

function decodeEscapedXmlEntities(value: string): string {
  return value.replace(
    ESCAPED_ENTITY_PATTERN,
    (entity) => ENTITY_DECODE[entity] ?? entity,
  );
}

export function normalizeLinkedContentPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const decoded = decodeEscapedXmlEntities(value);
  if (
    hasControlCharacter(decoded)
    || decoded.startsWith('/')
    || decoded.startsWith('\\')
    || WINDOWS_DRIVE_PATTERN.test(decoded)
    || WINDOWS_UNC_PATTERN.test(decoded)
  ) {
    return null;
  }

  const segments = decoded.replace(/\\/g, '/').split('/');
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    normalized.push(segment);
  }

  return normalized.length === 0 ? null : normalized.join('/');
}

export function assertLinkedContentPath(value: unknown): string {
  const normalized = normalizeLinkedContentPath(value);
  if (normalized === null) {
    throw new Error(`Invalid Linked content path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function decodeLinkedContentPathFields(
  value: Readonly<Record<string, unknown>>,
  canonicalKey = 'linkedContentPath',
  legacyKey = 'currentNote',
): LinkedContentPathDecodeResult {
  const hasCanonical = Object.prototype.hasOwnProperty.call(value, canonicalKey);
  const hasLegacy = Object.prototype.hasOwnProperty.call(value, legacyKey);

  if (hasCanonical) {
    const raw = value[canonicalKey];
    const path = normalizeLinkedContentPath(raw);
    if (path === null) {
      return { path: undefined, needsMigration: true, source: 'invalid' };
    }
    return {
      path,
      needsMigration: hasLegacy || path !== raw,
      source: 'canonical',
    };
  }

  if (hasLegacy) {
    const path = normalizeLinkedContentPath(value[legacyKey]);
    return path === null
      ? { path: undefined, needsMigration: true, source: 'invalid' }
      : { path, needsMigration: true, source: 'legacy' };
  }

  return { path: undefined, needsMigration: false, source: 'absent' };
}
