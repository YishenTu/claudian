import type { ProviderHost } from '../../../core/providers/ProviderHost';
import {
  type CodexDiscoveredModel,
  normalizeCodexDiscoveredModels,
} from '../models';
import { getCodexProviderSettings } from '../settings';
import { CodexAppServerProcess } from './CodexAppServerProcess';
import {
  initializeCodexAppServerTransport,
  resolveCodexAppServerLaunchSpec,
} from './codexAppServerSupport';
import type { ModelListResult } from './codexAppServerTypes';
import { CodexRpcTransport } from './CodexRpcTransport';

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
  discoverModels(signal?: AbortSignal): Promise<CodexModelDiscoveryResult>;
}

const MODEL_LIST_PAGE_SIZE = 100;

export class CodexModelDiscoveryService implements CodexModelDiscoveryServiceLike {
  constructor(private readonly plugin: ProviderHost) {}

  async discoverModels(signal?: AbortSignal): Promise<CodexModelDiscoveryResult> {
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

    let process: CodexAppServerProcess | null = null;
    let transport: CodexRpcTransport | null = null;
    let abortListener: (() => void) | null = null;

    try {
      const launchSpec = await resolveCodexAppServerLaunchSpec(this.plugin, 'codex');
      process = new CodexAppServerProcess(launchSpec);
      process.start();
      transport = new CodexRpcTransport(process);
      transport.start();

      abortListener = () => {
        transport?.dispose();
        if (process) {
          void process.shutdown().catch(() => {});
        }
      };
      signal?.addEventListener('abort', abortListener, { once: true });

      await initializeCodexAppServerTransport(transport);

      if (signal?.aborted) {
        return {
          kind: 'completed',
          diagnostics: 'Codex model discovery was cancelled',
          models: [],
        };
      }

      const entries: unknown[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const result: ModelListResult = await transport.request<ModelListResult>('model/list', {
          ...(cursor ? { cursor } : {}),
          includeHidden: false,
          limit: MODEL_LIST_PAGE_SIZE,
        });
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
      const stderr = process?.getStderrSnapshot() ?? '';
      return {
        diagnostics: stderr ? `${message}\n\n${stderr}` : message,
        kind: 'completed',
        models: [],
      };
    } finally {
      if (abortListener && signal) {
        signal.removeEventListener('abort', abortListener);
      }
      transport?.dispose();
      if (process) {
        await process.shutdown().catch(() => {});
      }
    }
  }
}
