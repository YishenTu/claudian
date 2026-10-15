interface MentionLookupMatch {
  resolvedPath: string;
  endIndex: number;
}

const TRAILING_PUNCTUATION_REGEX = /[),.!?:;]+$/;
const BOUNDARY_PUNCTUATION = new Set([',', ')', '!', '?', ':', ';']);

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function collectMentionEndCandidates(text: string, pathStart: number): number[] {
  const candidates = new Set<number>();

  for (let index = pathStart; index < text.length; index++) {
    const char = text[index];
    if (isWhitespace(char)) {
      candidates.add(index);
      continue;
    }

    if (BOUNDARY_PUNCTUATION.has(char)) {
      candidates.add(index + 1);
    }
  }

  candidates.add(text.length);
  return Array.from(candidates).sort((a, b) => b - a);
}

function isMentionStart(text: string, index: number): boolean {
  if (text[index] !== '@') return false;
  if (index === 0) return true;
  return isWhitespace(text[index - 1]);
}

function normalizeMentionPath(pathText: string): string {
  return pathText
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
}

function normalizeForPlatformLookup(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function findBestMentionLookupMatch(
  text: string,
  pathStart: number,
  pathLookup: Map<string, string>
): MentionLookupMatch | null {
  if (pathLookup.size === 0 || pathStart >= text.length) return null;

  const endCandidates = collectMentionEndCandidates(text, pathStart);
  for (const endIndex of endCandidates) {
    if (endIndex <= pathStart) continue;

    const rawPath = text.slice(pathStart, endIndex);
    const trailingPunctuation = rawPath.match(TRAILING_PUNCTUATION_REGEX)?.[0] ?? '';
    const rawPathWithoutPunctuation = trailingPunctuation
      ? rawPath.slice(0, -trailingPunctuation.length)
      : rawPath;

    const normalizedPath = normalizeMentionPath(rawPathWithoutPunctuation);
    if (!normalizedPath) continue;

    const resolvedPath = pathLookup.get(normalizeForPlatformLookup(normalizedPath));
    if (resolvedPath) {
      return {
        resolvedPath,
        endIndex,
      };
    }
  }

  return null;
}

/** Vault files named by whitespace-led `@path` mentions in a message, in first-seen order. */
export function resolveContextFiles(message: string, vaultFiles: readonly { path: string }[]): string[] {
  if (!message.includes('@')) return [];

  const pathLookup = new Map<string, string>();
  for (const file of vaultFiles) {
    // TFile paths are already Vault-relative; filesystem normalization would
    // expand literal `%VAR%`/`$VAR` segments and stat every file.
    const lookupKey = normalizeForPlatformLookup(normalizeMentionPath(file.path));
    if (lookupKey && !pathLookup.has(lookupKey)) {
      pathLookup.set(lookupKey, file.path);
    }
  }

  const resolved = new Set<string>();
  for (let index = 0; index < message.length; index++) {
    if (!isMentionStart(message, index)) continue;

    const vaultMatch = findBestMentionLookupMatch(message, index + 1, pathLookup);
    if (vaultMatch) {
      resolved.add(vaultMatch.resolvedPath);
      index = vaultMatch.endIndex - 1;
    }
  }

  return [...resolved];
}
