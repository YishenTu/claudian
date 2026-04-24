import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type ClaudianPlugin from '../../../main';
import { DEFAULT_CODEX_PRIMARY_MODEL } from '../types/models';
import { CodexAppServerProcess } from './CodexAppServerProcess';
import { resolveCodexAppServerLaunchSpec } from './codexAppServerSupport';
import type {
  AgentMessageDeltaNotification,
  ErrorNotification,
  InitializeResult,
  ThreadStartResult,
  TurnCompletedNotification,
  TurnStartResult,
} from './codexAppServerTypes';
import type { CodexLaunchSpec } from './codexLaunchTypes';
import { CodexRpcTransport } from './CodexRpcTransport';
import { createCodexRuntimeContext } from './CodexRuntimeContext';

export interface CodexAuxQueryConfig {
  systemPrompt: string;
  model?: string;
  abortController?: AbortController;
  onTextChunk?: (accumulatedText: string) => void;
}

/**
 * Runs ephemeral Codex app-server queries for auxiliary tasks
 * (title generation, instruction refinement, inline edit).
 * Manages its own process lifecycle, separate from the main chat runtime.
 * Supports multi-turn conversations within a single thread.
 */
export class CodexAuxQueryRunner {
  private process: CodexAppServerProcess | null = null;
  private transport: CodexRpcTransport | null = null;
  private threadId: string | null = null;
  private launchSpec: CodexLaunchSpec | null = null;

  constructor(private readonly plugin: ClaudianPlugin) {}

  async query(config: CodexAuxQueryConfig, prompt: string): Promise<string> {
    if (!this.process || !this.transport) {
      await this.startProcess();
    }

    if (!this.threadId) {
      const model = config.model ?? this.resolveProviderModel();
      const result = await this.transport!.request<ThreadStartResult>('thread/start', {
        model,
        cwd: this.launchSpec?.targetCwd ?? process.cwd(),
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: config.systemPrompt,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      });
      this.threadId = result.thread.id;
    }

    let accumulatedText = '';
    let turnError: string | null = null;
    let resolveWait: (() => void) | null = null;

    const donePromise = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });

    this.transport!.onNotification('item/agentMessage/delta', (params) => {
      const p = params as AgentMessageDeltaNotification;
      accumulatedText += p.delta;
      config.onTextChunk?.(accumulatedText);
    });

    this.transport!.onNotification('turn/completed', (params) => {
      const p = params as TurnCompletedNotification;
      if (p.turn.status === 'failed' && p.turn.error) {
        turnError = p.turn.error.message;
      }
      resolveWait?.();
    });

    this.transport!.onNotification('error', (params) => {
      const p = params as ErrorNotification;
      if (!p.willRetry) {
        turnError = p.error.message;
        resolveWait?.();
      }
    });

    // Resolve if process dies unexpectedly to avoid hanging forever
    const exitHandler = (): void => {
      if (!turnError) turnError = 'Codex app-server process exited unexpectedly';
      resolveWait?.();
    };
    this.process!.onExit(exitHandler);

    // Register abort handler before turn/start to avoid race condition
    let turnId: string | null = null;
    const abortHandler = (): void => {
      if (this.transport && this.threadId && turnId) {
        this.transport.request('turn/interrupt', {
          threadId: this.threadId,
          turnId,
        }).catch(() => {});
      }
      resolveWait?.();
    };

    config.abortController?.signal.addEventListener('abort', abortHandler, { once: true });

    // Check if already aborted before starting the turn
    if (config.abortController?.signal.aborted) {
      config.abortController.signal.removeEventListener('abort', abortHandler);
      this.process?.offExit(exitHandler);
      throw new Error('Cancelled');
    }

    const turnResult = await this.transport!.request<TurnStartResult>('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
      model: config.model,
    });
    turnId = turnResult.turn.id;

    try {
      await donePromise;
    } finally {
      config.abortController?.signal.removeEventListener('abort', abortHandler);
      this.process?.offExit(exitHandler);
    }

    if (config.abortController?.signal.aborted) {
      throw new Error('Cancelled');
    }

    if (turnError) {
      throw new Error(turnError);
    }

    return accumulatedText;
  }

  reset(): void {
    this.threadId = null;
    this.launchSpec = null;
    if (this.transport) {
      this.transport.dispose();
      this.transport = null;
    }
    if (this.process) {
      this.process.shutdown().catch(() => {});
      this.process = null;
    }
  }

  private resolveProviderModel(): string {
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      'codex',
    );
    return (providerSettings.model as string) ?? DEFAULT_CODEX_PRIMARY_MODEL;
  }

  private async startProcess(): Promise<void> {
    this.launchSpec = resolveCodexAppServerLaunchSpec(this.plugin, 'codex');
    this.process = new CodexAppServerProcess(this.launchSpec);
    this.process.start();

    this.transport = new CodexRpcTransport(this.process);
    this.transport.start();

    const initializeResult = await this.transport.request<InitializeResult>('initialize', {
      clientInfo: { name: 'claudian-aux', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });

    createCodexRuntimeContext(this.launchSpec, initializeResult);
    this.transport.notify('initialized');
  }
}
