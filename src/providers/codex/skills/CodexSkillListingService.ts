import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { CodexMetadataTransitionGate } from '../metadata/CodexMetadataTransitionGate';
import { CodexAppServerProcess } from '../runtime/CodexAppServerProcess';
import {
  initializeCodexAppServerTransport,
  resolveCodexAppServerLaunchSpec,
} from '../runtime/codexAppServerSupport';
import type {
  SkillMetadata,
  SkillScope,
  SkillsListResult,
} from '../runtime/codexAppServerTypes';
import { CodexRpcTransport } from '../runtime/CodexRpcTransport';
import { createCodexRuntimeContext } from '../runtime/CodexRuntimeContext';

export interface CodexSkillListProvider {
  listSkills(options?: {
    forceReload?: boolean;
    signal?: AbortSignal;
  }): Promise<SkillMetadata[]>;
  invalidate(): void;
}

interface CodexSkillListingServiceOptions {
  ttlMs?: number;
  now?: () => number;
  transitionGate?: CodexMetadataTransitionGate;
}

const DEFAULT_SKILL_LIST_TTL_MS = 5_000;

interface ActiveSkillFetch {
  readonly completion: Promise<void>;
  readonly controller: AbortController;
  resolveCompletion(): void;
}

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
  private pending: { generation: number; promise: Promise<SkillMetadata[]> } | null = null;
  private readonly activeFetches = new Set<ActiveSkillFetch>();
  private generation = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private readonly transitionGate: CodexMetadataTransitionGate;

  constructor(
    private readonly plugin: ProviderHost,
    options: CodexSkillListingServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SKILL_LIST_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.transitionGate = options.transitionGate ?? new CodexMetadataTransitionGate();
  }

  async listSkills(options?: {
    forceReload?: boolean;
    signal?: AbortSignal;
  }): Promise<SkillMetadata[]> {
    if (
      this.transitionGate.isUnavailable()
      && !await this.transitionGate.waitUntilAvailable(options?.signal)
    ) {
      return [];
    }
    if (this.disposed) return [];
    options?.signal?.throwIfAborted();
    if (options?.forceReload) {
      const generation = ++this.generation;
      return this.startFetch(true, generation, options.signal);
    }

    if (options?.signal) {
      if (this.cache && this.now() < this.cacheExpiresAt) {
        return this.cache;
      }
      // A request-scoped signal owns its process lifetime. Do not coalesce it
      // behind work that another consumer may invalidate independently.
      return this.startFetch(false, this.generation, options.signal);
    }

    if (this.pending?.generation === this.generation) {
      return this.pending.promise;
    }

    if (this.cache && this.now() < this.cacheExpiresAt) {
      return this.cache;
    }

    return this.startFetch(false, this.generation);
  }

  private startFetch(
    forceReload: boolean,
    generation: number,
    signal?: AbortSignal,
  ): Promise<SkillMetadata[]> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    let resolveCompletion!: () => void;
    const entry: ActiveSkillFetch = {
      completion: new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      }),
      controller,
      resolveCompletion: () => resolveCompletion(),
    };
    this.activeFetches.add(entry);
    const fetch = this.fetchSkills(forceReload, controller.signal);
    const promise = fetch
      .then((skills) => {
        if (generation === this.generation) {
          this.storeCache(skills);
        }
        return skills;
      })
      .finally(() => {
        signal?.removeEventListener('abort', onAbort);
        this.activeFetches.delete(entry);
        entry.resolveCompletion();
        if (this.pending?.promise === promise) {
          this.pending = null;
        }
      });
    if (!signal) {
      this.pending = { generation, promise };
    }
    return promise;
  }

  invalidate(): void {
    this.generation++;
    this.cache = null;
    this.cacheExpiresAt = 0;
    this.pending = null;
  }

  beginEnvironmentTransition(): void {
    this.transitionGate.beginTransition();
  }

  endEnvironmentTransition(): void {
    this.transitionGate.endTransition();
  }

  async quiesceForEnvironmentChange(): Promise<void> {
    this.invalidate();
    const active = [...this.activeFetches];
    for (const entry of active) entry.controller.abort();
    await Promise.all(active.map(entry => entry.completion));
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.transitionGate.dispose();
    this.disposePromise = this.quiesceForEnvironmentChange();
    return this.disposePromise;
  }

  private async fetchSkills(
    forceReload: boolean,
    signal?: AbortSignal,
  ): Promise<SkillMetadata[]> {
    signal?.throwIfAborted();
    const launchSpec = await resolveCodexAppServerLaunchSpec(this.plugin, 'codex');
    signal?.throwIfAborted();
    const process = new CodexAppServerProcess(launchSpec);
    process.start();

    const transport = new CodexRpcTransport(process);
    transport.start();
    const onAbort = (): void => transport.dispose();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const initializeResult = await initializeCodexAppServerTransport(transport);
      signal?.throwIfAborted();
      createCodexRuntimeContext(launchSpec, initializeResult);
      const result = await transport.request<SkillsListResult>('skills/list', {
        cwds: [launchSpec.targetCwd],
        ...(forceReload ? { forceReload: true } : {}),
      });

      const entry = result.data.find(candidate => candidate.cwd === launchSpec.targetCwd) ?? result.data[0];
      return (entry?.skills ?? []).map(skill => ({
        ...skill,
        path: launchSpec.pathMapper.toHostPath(skill.path) ?? skill.path,
      }));
    } finally {
      signal?.removeEventListener('abort', onAbort);
      transport.dispose();
      await process.shutdown();
    }
  }

  private storeCache(skills: SkillMetadata[]): void {
    this.cache = skills;
    this.cacheExpiresAt = this.now() + this.ttlMs;
  }
}
