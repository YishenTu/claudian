import {
  isExternalMentionQuery,
  isRelativeMentionQuery,
} from '@/utils/externalMention';

import type {
  ComposerDropdownItem,
  ComposerDropdownSource,
  ComposerDropdownValueItem,
  ComposerSelectionAction,
  ComposerTriggerMatch,
} from './types';

export interface FilesystemMentionEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface FilesystemMentionSourceDeps {
  /** Expands `~` and environment variables to an absolute path. */
  readonly expandHome: (value: string) => string;
  /**
   * Lists a directory's immediate children. Should resolve to an empty array on
   * any error (missing directory, permission denied) so the dropdown degrades
   * to "No matches" instead of surfacing a hard error.
   */
  readonly readDirectory: (
    absoluteDir: string,
    signal: AbortSignal,
  ) => Promise<readonly FilesystemMentionEntry[]>;
  /** Whether the feature is currently enabled. Re-read on every match. */
  readonly isEnabled: () => boolean;
  /**
   * Absolute base directory (the vault root) used to resolve relative queries
   * such as `./` and `../`. Returns null when unavailable, in which case
   * relative browsing is disabled.
   */
  readonly resolveBase?: () => string | null;
  /** Maximum items rendered per directory level. Defaults to 50. */
  readonly maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 50;

/** Collapses `.`/`..` segments in an absolute POSIX path. */
function normalizeAbsolutePosix(root: string, segments: string[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length === 0 ? (root || '/') : `${root}/${parts.join('/')}`;
}

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

/**
 * Browses files and folders outside the vault for `@` mentions.
 *
 * Only engages when the `@` query is an unambiguous filesystem path: absolute
 * (`/…`, `~/…`, `C:\…`, `\\…`) or relative to the vault (`./…`, `../…`);
 * ordinary `@name` queries return no match so the vault-scoped MentionSource
 * handles them. Register this source before MentionSource so it wins the tie
 * when both match a path-shaped query.
 *
 * Navigation mirrors the vault mention source: both files and directories are
 * plain, directly selectable entries. Selecting either inserts its absolute
 * path followed by a space to finish the mention — a directory is not a
 * drill-down, so referencing a folder is a single Enter, exactly like an
 * in-vault folder mention. To browse deeper the user keeps typing the path.
 */
export class FilesystemMentionSource implements ComposerDropdownSource {
  readonly id = 'external-file-mentions';
  readonly inputLoadPolicy = 'debounced';

  constructor(private readonly deps: FilesystemMentionSourceDeps) {}

  match(input: string, cursor: number): ComposerTriggerMatch | null {
    if (!this.deps.isEnabled()) return null;
    const before = input.slice(0, cursor);
    const index = before.lastIndexOf('@');
    if (index < 0 || (index > 0 && !/\s/.test(before[index - 1]))) return null;
    const query = before.slice(index + 1);
    // A space terminates a filesystem path: once whitespace appears anywhere
    // after `@`, the mention is complete (we auto-insert a trailing space on
    // selection) or the user has moved on to prose, so the dropdown must stay
    // closed. Unlike vault filenames, an externally typed path never needs an
    // interior space — space-containing directories are reached by selecting
    // them from the list, which inserts the full path rather than typing it.
    if (/\s/.test(query)) return null;
    if (!isExternalMentionQuery(query)) return null;
    // Relative queries need a vault base to resolve against.
    if (isRelativeMentionQuery(query) && !this.deps.resolveBase?.()) return null;
    return {
      atInputStart: index === 0,
      end: cursor,
      query,
      start: index,
      trigger: '@',
    };
  }

  async load(
    match: ComposerTriggerMatch,
    signal: AbortSignal,
  ): Promise<readonly ComposerDropdownItem[]> {
    const resolved = this.resolveQuery(match.query);
    if (!resolved) return [];
    return this.buildItems(resolved.dir, resolved.filter, signal);
  }

  select(
    item: ComposerDropdownValueItem,
    _match: ComposerTriggerMatch,
  ): ComposerSelectionAction {
    return { kind: 'replace', text: item.replacement };
  }

  /**
   * Splits a raw `@` query into the absolute directory to list and the trailing
   * basename to filter by, resolving `~` and relative (`.`/`..`) prefixes. The
   * split is done on the raw query first so trailing-slash intent survives home
   * expansion (which would otherwise normalize `~/` down to the home path).
   */
  private resolveQuery(query: string): { dir: string; filter: string } | null {
    const normalized = query.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    const dirToken = lastSlash < 0 ? normalized : normalized.slice(0, lastSlash);
    const filter = lastSlash < 0 ? '' : normalized.slice(lastSlash + 1);
    const dir = this.resolveDirToken(dirToken);
    if (dir === null) return null;
    return { dir, filter };
  }

  private resolveDirToken(dirToken: string): string | null {
    // Empty token means the query was rooted at "/" (e.g. "@/foo").
    if (dirToken === '') return '/';

    const expanded = this.deps.expandHome(dirToken).replace(/\\/g, '/');
    const driveMatch = /^([A-Za-z]:)(\/.*)?$/.exec(expanded);
    if (expanded.startsWith('/')) {
      return normalizeAbsolutePosix('', expanded.slice(1).split('/'));
    }
    if (driveMatch) {
      const rest = (driveMatch[2] ?? '').replace(/^\//, '');
      return normalizeAbsolutePosix(driveMatch[1], rest.split('/'));
    }
    // Relative token (".", "..", "./x", "../x") resolved against the vault base.
    const base = this.deps.resolveBase?.();
    if (!base) return null;
    const normalizedBase = base.replace(/\\/g, '/').replace(/\/+$/, '');
    const baseDrive = /^([A-Za-z]:)(\/.*)?$/.exec(normalizedBase);
    const root = baseDrive ? baseDrive[1] : '';
    const baseSegments = (baseDrive ? (baseDrive[2] ?? '') : normalizedBase)
      .replace(/^\//, '')
      .split('/');
    return normalizeAbsolutePosix(root, [...baseSegments, ...expanded.split('/')]);
  }

  private async buildItems(
    dir: string,
    filter: string,
    signal: AbortSignal,
  ): Promise<readonly ComposerDropdownItem[]> {
    const entries = await this.deps.readDirectory(dir, signal);
    if (signal.aborted) {
      throw new DOMException('External mention lookup was cancelled.', 'AbortError');
    }
    const normalizedFilter = filter.toLocaleLowerCase();
    const includeHidden = filter.startsWith('.');
    const maxResults = this.deps.maxResults ?? DEFAULT_MAX_RESULTS;

    return entries
      .filter((entry) => includeHidden || !entry.name.startsWith('.'))
      .filter((entry) => entry.name.toLocaleLowerCase().startsWith(normalizedFilter))
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
        return left.name.localeCompare(right.name);
      })
      .slice(0, maxResults)
      .map((entry) => this.toItem(dir, entry));
  }

  private toItem(
    dir: string,
    entry: FilesystemMentionEntry,
  ): ComposerDropdownValueItem {
    const fullPath = joinPath(dir, entry.name);
    // Directories and files are both directly selectable value items, matching
    // the vault mention source: selecting a folder inserts its path (single
    // Enter) rather than drilling in. Deeper browsing happens as the user keeps
    // typing the path. A folder's replacement keeps the trailing slash.
    if (entry.isDirectory) {
      return {
        className: 'is-external-folder',
        icon: 'folder',
        id: `external-folder:${fullPath}`,
        kind: 'value',
        label: `${fullPath}/`,
        replacement: `@${fullPath}/ `,
      };
    }
    return {
      className: 'is-external-file',
      detail: dir,
      icon: 'file',
      id: `external-file:${fullPath}`,
      kind: 'value',
      label: fullPath,
      replacement: `@${fullPath} `,
    };
  }
}
