import { CodexMetadataTransitionGate } from '../metadata/CodexMetadataTransitionGate';
import type { CodexAppServerRuntime } from '../runtime/CodexAppServerRuntime';
import type {
  SkillMetadata,
  SkillScope,
  SkillsListResult,
} from '../runtime/codexAppServerTypes';

export interface CodexSkillListProvider {
  listSkills(options?: {
    forceReload?: boolean;
    signal?: AbortSignal;
  }): Promise<SkillMetadata[]>;
  invalidate(): void;
}

interface CodexSkillListingServiceOptions {
  transitionGate?: CodexMetadataTransitionGate;
}

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

export function getCodexSkillDescription(
  skill: Pick<SkillMetadata, 'description' | 'shortDescription' | 'interface'>,
): string | undefined {
  return skill.interface?.shortDescription
    ?? skill.shortDescription
    ?? skill.description
    ?? undefined;
}

export class CodexSkillListingService implements CodexSkillListProvider {
  private pending: { generation: number; promise: Promise<SkillMetadata[]> } | null = null;
  private readonly activeFetches = new Set<ActiveSkillFetch>();
  private generation = 0;
  private readonly unsubscribe: () => void;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private readonly transitionGate: CodexMetadataTransitionGate;

  constructor(
    private readonly runtime: CodexAppServerRuntime,
    options: CodexSkillListingServiceOptions = {},
  ) {
    this.unsubscribe = runtime.onSkillsChanged(() => this.invalidate());
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
      return this.#startFetch(true, generation, options.signal);
    }

    if (options?.signal) {
      // A caller may abort its own query without cancelling another consumer.
      return this.#startFetch(false, this.generation, options.signal);
    }

    if (this.pending?.generation === this.generation) {
      return this.pending.promise;
    }

    return this.#startFetch(false, this.generation);
  }

  #startFetch(
    forceReload: boolean,
    generation: number,
    signal?: AbortSignal,
  ): Promise<SkillMetadata[]> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
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
    this.unsubscribe();
    this.transitionGate.dispose();
    this.disposePromise = this.quiesceForEnvironmentChange();
    return this.disposePromise;
  }

  private async fetchSkills(
    forceReload: boolean,
    signal?: AbortSignal,
  ): Promise<SkillMetadata[]> {
    signal?.throwIfAborted();
    const lease = await this.runtime.acquire({ signal });
    try {
      const { launchSpec, transport } = lease.connection;
      void lease.connection.refreshPlugins(forceReload).catch(() => undefined);
      signal?.throwIfAborted();
      const result = await transport.request<SkillsListResult>('skills/list', {
        cwds: [launchSpec.targetCwd],
        forceReload: true,
      }, undefined, signal);

      const entry = result.data.find(candidate => candidate.cwd === launchSpec.targetCwd) ?? result.data[0];
      return (entry?.skills ?? []).map(skill => ({
        ...skill,
        path: launchSpec.pathMapper.toHostPath(skill.path) ?? skill.path,
      }));
    } finally {
      await lease.release();
    }
  }

}
