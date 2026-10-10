import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderTransitionOwnerContext } from '../../../core/providers/types';
import {
  type CodexDiscoveredModel,
  normalizeCodexDiscoveredModels,
} from '../models';
import { getCodexProviderSettings } from '../settings';
import type { CodexAppServerLease, CodexAppServerRuntime } from './CodexAppServerRuntime';
import type { ModelListResult } from './codexAppServerTypes';

export type CodexModelDiscoveryResult =
  | {
    kind: 'completed';
    diagnostics?: string;
    models: CodexDiscoveredModel[];
  }
  | {
    kind: 'skipped';
    reason: 'provider-disabled';
  };

export interface CodexModelDiscoveryServiceLike {
  discoverModels(
    signal?: AbortSignal,
    context?: ProviderTransitionOwnerContext,
  ): Promise<CodexModelDiscoveryResult>;
}

const MODEL_LIST_PAGE_SIZE = 100;

export class CodexModelDiscoveryService implements CodexModelDiscoveryServiceLike {
  constructor(private readonly plugin: ProviderHost, private readonly runtime: CodexAppServerRuntime) {}

  async discoverModels(
    signal?: AbortSignal,
    context?: ProviderTransitionOwnerContext,
  ): Promise<CodexModelDiscoveryResult> {
    if (!getCodexProviderSettings(this.plugin.settings).enabled) {
      return { kind: 'skipped', reason: 'provider-disabled' };
    }

    if (signal?.aborted) {
      return {
        kind: 'completed',
        diagnostics: 'Codex model discovery was cancelled',
        models: [],
      };
    }

    let lease: CodexAppServerLease | null = null;

    try {
      lease = await this.runtime.acquire({ readiness: 'initialized', signal, context });
      const { transport } = lease.connection;

      const entries: unknown[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const result: ModelListResult = await transport.request<ModelListResult>('model/list', {
          ...(cursor ? { cursor } : {}),
          includeHidden: false,
          limit: MODEL_LIST_PAGE_SIZE,
        }, undefined, signal);
        entries.push(...result.data);

        const nextCursor: string | null = typeof result.nextCursor === 'string' && result.nextCursor.trim()
          ? result.nextCursor
          : null;
        if (nextCursor && seenCursors.has(nextCursor)) {
          throw new Error('Codex model/list returned a repeated cursor');
        }
        if (nextCursor) {
          seenCursors.add(nextCursor);
        }
        cursor = nextCursor;

        if (signal?.aborted) {
          return {
            kind: 'completed',
            diagnostics: 'Codex model discovery was cancelled',
            models: [],
          };
        }
      } while (cursor);

      return {
        kind: 'completed',
        models: normalizeCodexDiscoveredModels(entries),
      };
    } catch (error) {
      if (signal?.aborted) {
        return {
          kind: 'completed',
          diagnostics: 'Codex model discovery was cancelled',
          models: [],
        };
      }
      const message = error instanceof Error ? error.message : 'Codex model discovery failed';
      const stderr = lease?.connection.process.getStderrSnapshot() ?? '';
      return {
        diagnostics: stderr ? `${message}\n\n${stderr}` : message,
        kind: 'completed',
        models: [],
      };
    } finally {
      await lease?.release();
    }
  }
}
