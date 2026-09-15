/**
 * Claudian - External (outside-vault) mention utilities.
 *
 * A vault mention resolves through Obsidian's Vault API and is limited to files
 * inside the vault. When the "Allow @ mentions outside the vault" setting is on,
 * the composer additionally lets `@` reference absolute filesystem paths.
 *
 * This module owns the pure, side-effect-free helpers shared by the composer
 * (detecting an external-path query) and the Claude execution encoder (resolving
 * which directories to grant the agent read access to).
 */

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;
const RELATIVE_PREFIX = /^\.\.?(?:[\\/]|$)/;

/**
 * Returns true when a `@` query targets a filesystem path outside the vault.
 *
 * Two families trigger external browsing so that plain `@name` vault lookups are
 * never affected:
 * - Absolute: POSIX (`/Users/...`), home (`~` or `~/...`), Windows drive
 *   (`C:\...`), or UNC (`\\server\share`).
 * - Relative: `.`, `..`, `./...`, `../...` — resolved against the vault root,
 *   mirroring how a terminal resolves them against the working directory.
 */
export function isExternalMentionQuery(query: string): boolean {
  if (!query) return false;
  return (
    query === '~'
    || query.startsWith('~/')
    || query.startsWith('~\\')
    || query.startsWith('/')
    || WINDOWS_DRIVE_PREFIX.test(query)
    || query.startsWith('\\\\')
    || query === '.'
    || query === '..'
    || RELATIVE_PREFIX.test(query)
  );
}

/** True for `.`, `..`, `./…`, `../…` (and backslash variants). */
export function isRelativeMentionQuery(query: string): boolean {
  return query === '.' || query === '..' || RELATIVE_PREFIX.test(query);
}

export type PathKind = 'dir' | 'file' | null;

export interface ExternalMentionResolveDeps {
  /** Expands `~` and environment variables to an absolute path. */
  readonly expandHome: (value: string) => string;
  /** Classifies an absolute path; returns null when it does not exist. */
  readonly statPath: (absolutePath: string) => PathKind;
  /** Vault root used to resolve relative (`.`/`..`) mentions. */
  readonly resolveBase?: () => string | null;
}

function dirnameOf(posixPath: string): string {
  const index = posixPath.lastIndexOf('/');
  if (index <= 0) return '/';
  return posixPath.slice(0, index);
}

function joinPosix(base: string, rest: string): string {
  const normalizedBase = base.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${normalizedBase}/${rest}`;
}

/**
 * Converts a candidate path to an absolute POSIX-style string, expanding `~`
 * and resolving relative candidates against the vault root. Returns null when a
 * relative candidate cannot be resolved (no base available).
 */
export function toAbsoluteMentionPath(
  candidate: string,
  deps: ExternalMentionResolveDeps,
): string | null {
  const expanded = deps.expandHome(candidate).replace(/\\/g, '/');
  if (expanded.startsWith('/') || /^[A-Za-z]:\//.test(expanded)) {
    return expanded;
  }
  if (!isRelativeMentionQuery(candidate)) return null;
  const base = deps.resolveBase?.();
  if (!base) return null;
  return joinPosix(base, expanded);
}

/**
 * Resolves the deepest existing directory referenced by a candidate path.
 *
 * The candidate may have trailing prose glued on (paths can contain spaces, so
 * we cannot split on whitespace). We walk segment by segment while each grown
 * path still exists; `.`/`..` segments are collapsed, and the last existing
 * directory wins. A file resolves to its containing directory. Returns null when
 * nothing along the path exists.
 */
export function resolveExternalMentionDirectory(
  candidate: string,
  deps: ExternalMentionResolveDeps,
): string | null {
  const absolute = toAbsoluteMentionPath(candidate, deps);
  if (absolute === null) return null;

  const driveMatch = /^([A-Za-z]:)\//.exec(absolute);
  const root = driveMatch ? driveMatch[1] : '';
  const rest = driveMatch ? absolute.slice(driveMatch[0].length) : absolute.slice(1);

  const parts: string[] = [];
  const build = (): string => `${root}/${parts.join('/')}`;
  let bestDir: string | null = null;

  for (const segment of rest.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0) parts.pop();
      bestDir = build();
      continue;
    }
    parts.push(segment);
    const candidatePath = build();
    const kind = deps.statPath(candidatePath);
    if (kind === null) {
      parts.pop();
      break;
    }
    if (kind === 'file') {
      bestDir = dirnameOf(candidatePath);
      break;
    }
    bestDir = candidatePath;
  }

  return bestDir;
}

const EXTERNAL_MENTION_TRIGGER =
  /(^|\s)@(\/|~(?:$|[/\\])|\.\.?(?:$|[/\\])|[A-Za-z]:[\\/]|\\\\)/g;

/**
 * Extracts the set of directories that external `@` mentions in `text` should
 * grant the agent read access to. Each mention resolves to the deepest existing
 * directory it references (see resolveExternalMentionDirectory). Duplicates are
 * removed while preserving first-seen order.
 */
export function extractExternalMentionDirectories(
  text: string,
  deps: ExternalMentionResolveDeps,
): string[] {
  if (!text.includes('@')) return [];

  const directories = new Set<string>();
  const pattern = new RegExp(EXTERNAL_MENTION_TRIGGER);
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // The captured path begins right after the `@` sign.
    const pathStart = match.index + match[1].length + 1;
    const line = text.slice(pathStart).split('\n')[0];
    const candidate = line.trim();
    if (!candidate) continue;
    const directory = resolveExternalMentionDirectory(candidate, deps);
    if (directory) directories.add(directory);
  }

  return [...directories];
}
