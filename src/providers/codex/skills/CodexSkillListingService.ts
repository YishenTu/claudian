import type ClaudianPlugin from '../../../main';
import { CodexAppServerProcess } from '../runtime/CodexAppServerProcess';
import {
  buildCodexAppServerEnvironment,
  getCodexAppServerWorkingDirectory,
  initializeCodexAppServerTransport,
} from '../runtime/codexAppServerSupport';
import type {
  SkillMetadata,
  SkillScope,
  SkillsListResult,
} from '../runtime/codexAppServerTypes';
import { CodexRpcTransport } from '../runtime/CodexRpcTransport';

export interface CodexSkillListProvider {
  listSkills(options?: { forceReload?: boolean }): Promise<SkillMetadata[]>;
  invalidate(): void;
}

interface CodexSkillListingServiceOptions {
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_SKILL_LIST_TTL_MS = 5_000;

const SKILL_SCOPE_PRIORITY: Record<SkillScope, number> = {
  repo: 0,
  user: 1,
  system: 2,
  admin: 3,
};

export function compareCodexSkillPriority(
  left: Pick<SkillMetadata, 'name' | 'path' | 'scope'>,
  right: Pick<SkillMetadata, 'name' | 'path' | 'scope'>,
): number {
  const scopeDelta = SKILL_SCOPE_PRIORITY[left.scope] - SKILL_SCOPE_PRIORITY[right.scope];
  if (scopeDelta !== 0) {
    return scopeDelta;
  }

  const nameDelta = left.name.localeCompare(right.name);
  if (nameDelta !== 0) {
    return nameDelta;
  }

  return left.path.localeCompare(right.path);
}

export function extractExplicitCodexSkillNames(text: string): string[] {
  const matches = text.matchAll(/(^|\s)\$([A-Za-z0-9_-]+)/g);
  const names: string[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const name = match[2];
    if (!name) {
      continue;
    }

    const normalized = name.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    names.push(name);
  }

  return names;
}

export function getCodexSkillDescription(
  skill: Pick<SkillMetadata, 'description' | 'shortDescription' | 'interface'>,
): string | undefined {
  return skill.interface?.shortDescription
    ?? skill.shortDescription
    ?? skill.description
    ?? undefined;
}

export function findPreferredCodexSkillByName(
  skills: SkillMetadata[],
  name: string,
): SkillMetadata | null {
  const normalized = name.toLowerCase();
  const candidates = skills
    .filter(skill => skill.enabled && skill.name.toLowerCase() === normalized)
    .sort(compareCodexSkillPriority);

  return candidates[0] ?? null;
}

export class CodexSkillListingService implements CodexSkillListProvider {
  private cache: SkillMetadata[] | null = null;
  private cacheExpiresAt = 0;
  private pending: Promise<SkillMetadata[]> | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly plugin: ClaudianPlugin,
    options: CodexSkillListingServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SKILL_LIST_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async listSkills(options?: { forceReload?: boolean }): Promise<SkillMetadata[]> {
    if (options?.forceReload) {
      const skills = await this.fetchSkills(true);
      this.storeCache(skills);
      return skills;
    }

    if (this.cache && this.now() < this.cacheExpiresAt) {
      return this.cache;
    }

    if (this.pending) {
      return this.pending;
    }

    this.pending = this.fetchSkills(false)
      .then((skills) => {
        this.storeCache(skills);
        return skills;
      })
      .finally(() => {
        this.pending = null;
      });

    return this.pending;
  }

  invalidate(): void {
    this.cache = null;
    this.cacheExpiresAt = 0;
  }

  private async fetchSkills(forceReload: boolean): Promise<SkillMetadata[]> {
    const cwd = getCodexAppServerWorkingDirectory(this.plugin);
    const codexPath = this.plugin.getResolvedProviderCliPath('codex') ?? 'codex';
    const env = buildCodexAppServerEnvironment(this.plugin, 'codex');
    const process = new CodexAppServerProcess(codexPath, cwd, env);
    process.start();

    const transport = new CodexRpcTransport(process);
    transport.start();

    try {
      await initializeCodexAppServerTransport(transport);
      const result = await transport.request<SkillsListResult>('skills/list', {
        cwds: [cwd],
        ...(forceReload ? { forceReload: true } : {}),
      });

      const entry = result.data.find(candidate => candidate.cwd === cwd) ?? result.data[0];
      return entry?.skills ?? [];
    } finally {
      transport.dispose();
      await process.shutdown();
    }
  }

  private storeCache(skills: SkillMetadata[]): void {
    this.cache = skills;
    this.cacheExpiresAt = this.now() + this.ttlMs;
  }
}
