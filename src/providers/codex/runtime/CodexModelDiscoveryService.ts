import type ClaudianPlugin from '../../../main';
import {
  type CodexDiscoveredModel,
  normalizeCodexDiscoveredModels,
} from '../models';
import { CodexAppServerProcess } from './CodexAppServerProcess';
import {
  initializeCodexAppServerTransport,
  resolveCodexAppServerLaunchSpec,
} from './codexAppServerSupport';
import type { ModelListResult } from './codexAppServerTypes';
import { CodexRpcTransport } from './CodexRpcTransport';

export interface CodexModelDiscoveryResult {
  diagnostics?: string;
  models: CodexDiscoveredModel[];
}

const MODEL_LIST_PAGE_SIZE = 100;

export class CodexModelDiscoveryService {
  constructor(private readonly plugin: ClaudianPlugin) {}

  async discoverModels(): Promise<CodexModelDiscoveryResult> {
    let process: CodexAppServerProcess | null = null;
    let transport: CodexRpcTransport | null = null;

    try {
      const launchSpec = resolveCodexAppServerLaunchSpec(this.plugin, 'codex');
      process = new CodexAppServerProcess(launchSpec);
      process.start();
      transport = new CodexRpcTransport(process);
      transport.start();
      await initializeCodexAppServerTransport(transport);

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
      } while (cursor);

      return { models: normalizeCodexDiscoveredModels(entries) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Codex model discovery failed';
      const stderr = process?.getStderrSnapshot() ?? '';
      return {
        diagnostics: stderr ? `${message}\n\n${stderr}` : message,
        models: [],
      };
    } finally {
      transport?.dispose();
      if (process) {
        await process.shutdown().catch(() => {});
      }
    }
  }
}
