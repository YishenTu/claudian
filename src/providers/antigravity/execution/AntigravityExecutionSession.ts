import { randomUUID } from 'crypto';

import {
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  RequestedRunChannel,
  SessionSnapshotState,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ChatMessage, SlashCommand } from '@/core/types';
import { ACPRequestedTurn } from '@/providers/acp/ACPRequestedTurn';
import { buildACPUsageInfo } from '@/providers/acp/buildACPUsageInfo';
import type { ACPSessionNotification } from '@/providers/acp/types';

import { BUILT_IN_ANTIGRAVITY_COMMANDS } from '../commands/AntigravityCommandCatalog';
import {
  decodeAntigravityModelId,
  DEFAULT_ANTIGRAVITY_MODEL,
} from '../models';
import { createAntigravityToolStreamAdapter } from '../normalization/antigravityToolNormalization';
import { buildAntigravityPromptBlocks } from '../runtime/buildAntigravityPrompt';
import { getAntigravityProviderSettings } from '../settings';
import { getAntigravityState } from '../types';
import { AntigravityACPSessionKernel } from './AntigravityACPSessionKernel';
import type {
  AntigravityNativeSessionInfo,
  AntigravitySessionKernel,
} from './AntigravitySessionContract';

interface AntigravityActiveRun {
  readonly run: RequestedRunChannel;
  readonly turn: ACPRequestedTurn;
  cancellationRequested: boolean;
  nativeCompleted: boolean;
}

export class AntigravityExecutionSession implements ProviderExecutionSession {
  readonly providerId = 'antigravity' as const;
  readonly sessionInstanceId = randomUUID();

  private activeRun: AntigravityActiveRun | null = null;
  private kernel: AntigravitySessionKernel | null = null;
  private nativeSessionId: string | null = null;
  private readonly state: SessionSnapshotState;
  private disposed = false;
  private lifecycleGeneration = 0;
  private commands: SlashCommand[] = [...BUILT_IN_ANTIGRAVITY_COMMANDS];

  constructor(
    private readonly plugin: ProviderHost,
    private readonly config: ProviderSessionConfig,
  ) {
    const providerState = getAntigravityState(config.resumeSeed?.providerState);
    this.nativeSessionId = config.resumeSeed?.providerSessionId ?? providerState.sessionId ?? null;

    this.state = new SessionSnapshotState({
      providerId: this.providerId,
      providerState: {
        ...(providerState.sessionId ? { sessionId: providerState.sessionId } : {}),
        ...(providerState.currentModeId ? { currentModeId: providerState.currentModeId } : {}),
        ...(providerState.currentModelId ? { currentModelId: providerState.currentModelId } : {}),
      },
      readProviderSessionId: () => this.nativeSessionId,
      projectProviderState: (state) => ({
        ...state,
        ...(this.nativeSessionId ? { sessionId: this.nativeSessionId } : {}),
      }),
      sessionInstanceId: this.sessionInstanceId,
    });
  }

  getCommandSnapshot(): readonly SlashCommand[] {
    return this.commands;
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.state.getSnapshot();
  }

  getStatus(): ProviderSessionStatus {
    return this.state.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    return this.state.onEvent(listener);
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('Antigravity execution session is disposed');
    if (this.activeRun) {
      throw new Error('Antigravity execution session already has an active run');
    }

    const run = new RequestedRunChannel({
      onCancel: () => this.#cancelRun(active),
      sessionInstanceId: this.sessionInstanceId,
    });

    const active: AntigravityActiveRun = {
      cancellationRequested: false,
      nativeCompleted: false,
      run,
      turn: new ACPRequestedTurn({
        onAccept: () => {
          this.state.setStatus('executing');
        },
        resolveUsageModel: () => this.#resolveSelectedRawModelId(request.configuration.model),
        run,
        toolStreamAdapter: createAntigravityToolStreamAdapter(),
      }),
    };

    this.activeRun = active;
    run.attachAbortSignal(request.signal);
    if (!active.cancellationRequested) {
      void this.#startRun(active, request);
    }
    return run;
  }

  cancel(): void {
    if (this.activeRun && !this.activeRun.run.isTerminal) {
      this.activeRun.run.cancel();
      return;
    }
    if (this.nativeSessionId && this.kernel) {
      this.kernel.cancel(this.nativeSessionId);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    if (this.kernel) {
      await this.kernel.dispose();
      this.kernel = null;
    }
    this.state.clearListeners();
  }

  #resolveSelectedRawModelId(requestedModel?: string): string {
    const raw = decodeAntigravityModelId(requestedModel ?? '');
    if (raw) return raw;
    const settings = getAntigravityProviderSettings(this.plugin.settings);
    return settings.selectedModel || DEFAULT_ANTIGRAVITY_MODEL;
  }

  async #startRun(active: AntigravityActiveRun, request: ProviderExecutionRequest): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    try {
      this.state.setStatus('executing');

      if (!this.kernel) {
        const kernel = new AntigravityACPSessionKernel({
          config: this.config,
          getActiveTurnId: () => (this.activeRun === active ? 'main' : null),
          onClosed: (error) => {
            if (this.activeRun === active && !active.run.isTerminal) {
              active.run.finish({
                category: 'provider',
                message: error instanceof Error ? error.message : String(error),
                recoverable: true,
                type: 'execution_error',
              });
            }
          },
          onNotification: (notification) => {
            this.#handleNotification(generation, active, notification);
          },
          plugin: this.plugin,
          sessionInstanceId: this.sessionInstanceId,
        });
        this.kernel = kernel;
        await kernel.connect();

        if (this.#isStale(active, generation)) return;

        const sessionInfo: AntigravityNativeSessionInfo = await kernel.openSession(
          this.nativeSessionId ?? undefined,
        );
        this.nativeSessionId = sessionInfo.sessionId;
        this.state.setProviderStateValue('sessionId', this.nativeSessionId);

        // Apply mode and model
        const targetModel = this.#resolveSelectedRawModelId(request.configuration.model);
        await kernel.setModel(targetModel);

        const providerSettings = getAntigravityProviderSettings(this.plugin.settings);
        const targetMode = request.configuration.permissionMode || providerSettings.permissionMode || 'default';
        await kernel.setMode(targetMode);
      }

      if (this.#isStale(active, generation)) return;

      active.turn.beginLiveOutput();

      const promptBlocks = this.#buildPromptBlocks(request);
      const response = await this.kernel.prompt({
        prompt: promptBlocks,
        sessionId: this.nativeSessionId!,
      });

      if (this.#isStale(active, generation)) return;

      active.nativeCompleted = response.stopReason !== 'cancelled';
      active.turn.accept(response.userMessageId);

      if (response.usage) {
        const usage = buildACPUsageInfo({
          contextWindow: active.turn.contextUsage,
          model: this.#resolveSelectedRawModelId(request.configuration.model),
          promptUsage: response.usage,
        });
        if (usage) active.run.emit({ type: 'usage_updated', usage });
      }

      this.state.setStatus('idle');
      active.run.finish(
        response.stopReason === 'cancelled'
          ? { reason: 'provider-cancelled', type: 'cancelled' }
          : { reason: 'completed', type: 'turn_completed' },
      );
    } catch (error) {
      if (this.#isStale(active, generation)) return;
      const errMessage = error instanceof Error ? error.message : String(error);
      this.state.setStatus('idle');
      active.run.finish({
        category: 'provider',
        message: errMessage,
        recoverable: true,
        type: 'execution_error',
      });
    } finally {
      if (this.activeRun === active) {
        this.activeRun = null;
      }
    }
  }

  #buildPromptBlocks(request: ProviderExecutionRequest) {
    const text = request.input
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(({ text: val }) => val)
      .join('\n');
    const images = request.input
      .filter((block): block is Extract<typeof block, { type: 'image' }> => block.type === 'image')
      .map(({ image }) => image);

    return buildAntigravityPromptBlocks(
      {
        browserSelection: request.context?.browserSelection,
        canvasSelection: request.context?.canvasSelection,
        editorSelection: request.context?.editorSelection,
        images,
        linkedContent: request.context?.linkedContent,
        selections: request.context?.selections,
        sessionReferences: request.context?.sessionReferences,
        text,
      },
      request.conversationHistory ? [...request.conversationHistory] as ChatMessage[] : [],
    );
  }

  #cancelRun(active: AntigravityActiveRun): void {
    active.cancellationRequested = true;
    if (this.nativeSessionId && this.kernel) {
      this.kernel.cancel(this.nativeSessionId);
    }
    active.run.finish({ reason: 'provider-cancelled', type: 'cancelled' });
    if (this.activeRun === active) {
      this.activeRun = null;
    }
    this.state.setStatus('idle');
  }

  #isStale(active: AntigravityActiveRun, generation: number): boolean {
    return this.disposed || this.lifecycleGeneration !== generation || active.cancellationRequested;
  }

  #handleNotification(
    generation: number,
    active: AntigravityActiveRun,
    notification: ACPSessionNotification,
  ): void {
    if (this.#isStale(active, generation) || notification.sessionId !== this.nativeSessionId) {
      return;
    }

    try {
      const metadata = active.turn.handleUpdate(notification.update);
      if (metadata?.type === 'commands') {
        this.commands = metadata.commands.map((cmd) => ({ ...cmd }));
        this.state.emit({
          type: 'commands_changed',
        });
      }
    } catch {
      // ignore update errors
    }
  }
}
