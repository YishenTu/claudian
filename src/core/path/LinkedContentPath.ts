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
