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
// Only text that may have gone through prompt rendering is decoded with it: the
// rendered `<linked_content path="...">` attribute is the only machine-readable
// linked-note signal the agent receives, so an escaped copy it pasted back into
// plugin state (legacy session metadata, input ledgers) must be repaired on
// ingestion. Ground-truth vault paths keep their literal on-disk name. Single
// pass, one level only.
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

/**
 * Canonicalizes a path that is trusted to be literal path text (vault API paths,
 * vault rename/delete events, UI selections, paths read back from structured
 * storage). Entity-shaped substrings are ordinary name characters here: a real
 * folder named `People &amp; Teams` is a different folder from `People & Teams`
 * and must not be rewritten into it.
 */
export function normalizeLinkedContentPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (
    hasControlCharacter(value)
    || value.startsWith('/')
    || value.startsWith('\\')
    || WINDOWS_DRIVE_PATTERN.test(value)
    || WINDOWS_UNC_PATTERN.test(value)
  ) {
    return null;
  }

  const segments = value.replace(/\\/g, '/').split('/');
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    normalized.push(segment);
  }

  return normalized.length === 0 ? null : normalized.join('/');
}

/**
 * Ingestion-boundary repair for provider-facing text, i.e. values that may have
 * been rendered into a prompt attribute and copied back by the agent. Decodes
 * the escaper's own output set once, then canonicalizes; escapes that decode to
 * control characters stay rejected.
 */
export function normalizeEscapedLinkedContentPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return normalizeLinkedContentPath(decodeEscapedXmlEntities(value));
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
    const path = normalizeEscapedLinkedContentPath(raw);
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
    const path = normalizeEscapedLinkedContentPath(value[legacyKey]);
    return path === null
      ? { path: undefined, needsMigration: true, source: 'invalid' }
      : { path, needsMigration: true, source: 'legacy' };
  }

  return { path: undefined, needsMigration: false, source: 'absent' };
}
