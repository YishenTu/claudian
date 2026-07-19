import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getVaultPath } from '../../../utils/path';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  type AcpReadTextFileRequest,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  AcpSessionUpdateNormalizer,
  AcpSubprocess,
  extractAcpSessionModelState,
} from '../../acp';
import { decodeKimiModelId } from '../models';
import { formatKimiRuntimeError } from './KimiChatRuntime';
import { buildKimiRuntimeEnv } from './KimiRuntimeEnvironment';

/**
 * Temporary ACP session runner for auxiliary prompts.
 * Never silently approves tools — permission requests are cancelled.
 */
export class KimiAuxQueryRunner implements AuxQueryRunner {
  private availableModelIds = new Set<string>();
  private connection: AcpClientConnection | null = null;
  private currentModelId: string | null = null;
  private currentLaunchKey: string | null = null;
  private process: AcpSubprocess | null = null;
  private readonly sessionCwds = new Map<string, string>();
  private sessionId: string | null = null;
  private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();
  /** Serialized/deduplicated process shutdown so reset cannot race a later start. */
  private shutdownBarrier: Promise<void> | null = null;
  private transport: AcpJsonRpcTransport | null = null;
  private allowReadTextFile: boolean;

  constructor(
    private readonly plugin: ProviderHost,
    options: { allowReadTextFile?: boolean } = {},
  ) {
    this.allowReadTextFile = options.allowReadTextFile === true;
  }

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    await this.ensureReady(cwd);

    if (!this.connection) {
      throw new Error('Kimi Code runtime is not ready.');
    }

    if (!this.sessionId) {
      const sessionId = await this.createSession(cwd);
      if (!sessionId) {
        throw new Error(
          'Failed to create a Kimi Code session. Run `kimi login` if authentication is required.',
        );
      }
    }

    const sessionId = this.sessionId!;
    const selectedModel = this.resolveSelectedRawModel(config.model);
    const nextModel = this.resolveApplicableModel(selectedModel);
    if (nextModel) {
      const response = await this.connection.setConfigOption({
        configId: 'model',
        sessionId,
        type: 'select',
        value: nextModel,
      });
      this.syncSessionModelState({
        configOptions: response.configOptions,
      });
    }

    this.sessionUpdateNormalizer.reset();
    let accumulatedText = '';
    const removeListener = this.connection.onSessionNotification((notification) => {
      if (notification.sessionId !== sessionId) {
        return;
      }

      const normalized = this.sessionUpdateNormalizer.normalize(notification.update);
      if (normalized.type !== 'message_chunk' || normalized.role !== 'assistant') {
        return;
      }

      for (const chunk of normalized.streamChunks) {
        if (chunk.type !== 'text') {
          continue;
        }

        accumulatedText += chunk.content;
        config.onTextChunk?.(accumulatedText);
      }
    });

    const abortHandler = () => {
      if (this.connection && this.sessionId) {
        this.connection.cancel({ sessionId: this.sessionId });
      }
    };
    config.abortController?.signal.addEventListener('abort', abortHandler, { once: true });

    try {
      if (config.abortController?.signal.aborted) {
        throw new Error('Cancelled');
      }

      const promptText = config.systemPrompt
        ? `${config.systemPrompt.trim()}\n\n${prompt}`
        : prompt;

      await this.connection.prompt({
        prompt: [{ type: 'text', text: promptText }],
        sessionId,
      });

      if (config.abortController?.signal.aborted) {
        throw new Error('Cancelled');
      }

      return accumulatedText;
    } catch (error) {
      throw new Error(
        formatKimiRuntimeError(error, this.process?.getStderrSnapshot()),
        error instanceof Error ? { cause: error } : undefined,
      );
    } finally {
      config.abortController?.signal.removeEventListener('abort', abortHandler);
      removeListener();
    }
  }

  /**
   * Synchronously clear session state and schedule process shutdown.
   * Public interface stays void; callers that need deterministic cleanup
   * (ensureReady) await the internal shutdown barrier.
   */
  reset(): void {
    this.clearRuntimeState();
    void this.beginShutdown();
  }

  private clearRuntimeState(): void {
    this.availableModelIds.clear();
    this.sessionId = null;
    this.sessionCwds.clear();
    this.currentModelId = null;
    this.currentLaunchKey = null;
    this.connection?.dispose();
    this.connection = null;
    this.transport?.dispose();
    this.transport = null;
    this.sessionUpdateNormalizer.reset();
  }

  /**
   * Capture the current process (if any) and chain its shutdown onto the
   * shared barrier. Concurrent reset/start callers share one in-flight
   * promise so shutdown is deduplicated and ordered.
   */
  private beginShutdown(): Promise<void> {
    const process = this.process;
    this.process = null;

    if (!process && !this.shutdownBarrier) {
      return Promise.resolve();
    }

    const previous = this.shutdownBarrier;
    const next = (async () => {
      if (previous) {
        await previous.catch(() => {});
      }
      if (process) {
        await process.shutdown().catch(() => {});
      }
    })();

    this.shutdownBarrier = next;
    void next.finally(() => {
      if (this.shutdownBarrier === next) {
        this.shutdownBarrier = null;
      }
    });
    return next;
  }

  private async awaitShutdownBarrier(): Promise<void> {
    while (this.shutdownBarrier) {
      const barrier = this.shutdownBarrier;
      await barrier.catch(() => {});
      if (this.shutdownBarrier === barrier) {
        this.shutdownBarrier = null;
      }
    }
  }

  private async ensureReady(cwd: string): Promise<void> {
    // Finish any in-flight shutdown before inspecting or spawning.
    await this.awaitShutdownBarrier();

    const resolvedCliPath = await this.plugin.getResolvedProviderCliPath('kimi');
    if (!resolvedCliPath) {
      throw new Error(
        'Kimi Code CLI not found. Install Kimi Code (>= 0.27.0) or set the CLI path in Claudian settings.',
      );
    }

    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const nextLaunchKey = JSON.stringify({
      command: resolvedCliPath,
      envText: getRuntimeEnvironmentText(settings, 'kimi'),
    });

    const shouldRestart = !this.process
      || !this.transport
      || !this.connection
      || !this.process.isAlive()
      || this.transport.isClosed
      || this.currentLaunchKey !== nextLaunchKey;

    if (!shouldRestart) {
      return;
    }

    // Tear down and wait for the old process to fully exit before spawning.
    this.clearRuntimeState();
    await this.beginShutdown();

    const env = buildKimiRuntimeEnv(settings, resolvedCliPath);
    this.process = new AcpSubprocess({
      args: ['acp'],
      command: resolvedCliPath,
      cwd,
      env,
    });
    this.process.start();

    this.transport = new AcpJsonRpcTransport({
      input: this.process.stdout,
      onClose: (listener) => this.process!.onClose(listener),
      output: this.process.stdin,
    });

    this.connection = new AcpClientConnection({
      clientInfo: {
        name: 'claudian-kimi-aux',
        version: this.plugin.manifest?.version ?? '0.0.0',
      },
      delegate: {
        fileSystem: {
          readTextFile: (request) => this.readTextFile(request),
          writeTextFile: async () => ({}),
        },
        requestPermission: (request) => this.handlePermissionRequest(request),
      },
      transport: this.transport,
    });

    this.transport.start();
    await this.connection.initialize({
      clientCapabilities: {
        fs: {
          readTextFile: this.allowReadTextFile,
          writeTextFile: false,
        },
      },
    });
    this.currentLaunchKey = nextLaunchKey;
  }

  private async createSession(cwd: string): Promise<string | null> {
    if (!this.connection) {
      return null;
    }

    try {
      const response = await this.connection.newSession({
        cwd,
        mcpServers: [],
      });
      const sessionId = response.sessionId;
      if (!sessionId) {
        return null;
      }
      this.sessionId = sessionId;
      this.sessionCwds.set(sessionId, cwd);
      this.syncSessionModelState({
        configOptions: response.configOptions,
        models: response.models,
      });
      return sessionId;
    } catch (error) {
      throw new Error(
        formatKimiRuntimeError(error, this.process?.getStderrSnapshot()),
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  private resolveSelectedRawModel(model: string | undefined): string | null {
    if (!model) {
      return null;
    }
    return decodeKimiModelId(model) ?? (model.includes(':') ? null : model.trim() || null);
  }

  private resolveApplicableModel(selected: string | null): string | null {
    if (!selected) {
      return null;
    }
    if (this.availableModelIds.size > 0 && !this.availableModelIds.has(selected)) {
      return null;
    }
    if (selected === this.currentModelId) {
      return null;
    }
    return selected;
  }

  private syncSessionModelState(params: {
    configOptions?: unknown;
    models?: unknown;
  }): void {
    const state = extractAcpSessionModelState(params as {
      configOptions?: Parameters<typeof extractAcpSessionModelState>[0]['configOptions'];
      models?: Parameters<typeof extractAcpSessionModelState>[0]['models'];
    });
    if (state.currentModelId) {
      this.currentModelId = state.currentModelId;
    }
    this.availableModelIds = new Set(state.availableModels.map((model) => model.id));
  }

  private async handlePermissionRequest(
    _request: AcpRequestPermissionRequest,
  ): Promise<AcpRequestPermissionResponse> {
    // Auxiliary prompts must not silently approve tools.
    return { outcome: { outcome: 'cancelled' } };
  }

  private async readTextFile(
    request: AcpReadTextFileRequest,
  ): Promise<{ content: string }> {
    if (!this.allowReadTextFile) {
      throw new Error('Kimi auxiliary runner denied filesystem read.');
    }
    const resolvedPath = this.resolveSessionPath(request.sessionId, request.path);
    const content = await fs.readFile(resolvedPath, 'utf-8');
    if (request.line === undefined && request.limit === undefined) {
      return { content };
    }
    const lines = content.split(/\r?\n/);
    const startIndex = Math.max(0, (request.line ?? 1) - 1);
    const endIndex = request.limit
      ? startIndex + Math.max(0, request.limit)
      : lines.length;
    return {
      content: lines.slice(startIndex, endIndex).join('\n'),
    };
  }

  private resolveSessionPath(sessionId: string, rawPath: string): string {
    if (path.isAbsolute(rawPath)) {
      return rawPath;
    }
    const cwd = this.sessionCwds.get(sessionId)
      ?? getVaultPath(this.plugin.app)
      ?? process.cwd();
    return path.resolve(cwd, rawPath);
  }
}
