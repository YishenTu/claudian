import { spawn } from 'child_process';
import * as readline from 'readline';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderCapabilities, ProviderId } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnResult,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  ExitPlanModeCallback,
  PreparedChatTurn,
  SessionUpdateResult,
  SubagentRuntimeState,
} from '../../../core/runtime/types';
import type { ChatMessage, Conversation, SlashCommand, StreamChunk } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';
import { CURSOR_PROVIDER_CAPABILITIES } from '../capabilities';
import { encodeCursorTurn } from '../prompt/encodeCursorTurn';
import { getCursorState, resolveCursorSessionId } from '../types';
import { buildCursorAgentEnvironment } from './cursorAgentEnv';
import { resolveCursorModelForCli } from './cursorCliModel';
import { buildCursorAgentFlagArgs, type CursorPermissionMode } from './cursorLaunchArgs';
import { CursorNdjsonStreamReducer } from './cursorStreamMapper';

export class CursorChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'cursor';

  private plugin: ClaudianPlugin;
  private ready = false;
  private readyListeners = new Set<(ready: boolean) => void>();
  private canceled = false;
  private child: ReturnType<typeof spawn> | null = null;
  private lastSessionId: string | null = null;
  private activeResumeId: string | null = null;
  private turnMetadata: ChatTurnMetadata = {};

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return CURSOR_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return encodeCursorTurn(request);
  }

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = { ...this.turnMetadata };
    this.turnMetadata = {};
    return metadata;
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {}

  syncConversationState(conversation: ChatRuntimeConversationState | null): void {
    if (!conversation) {
      this.activeResumeId = null;
      return;
    }
    this.activeResumeId = resolveCursorSessionId(conversation);
  }

  async reloadMcpServers(): Promise<void> {}

  async ensureReady(_options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    const cli = this.plugin.getResolvedProviderCliPath('cursor');
    const nextReady = !!cli;
    if (this.ready !== nextReady) {
      this.ready = nextReady;
      for (const listener of this.readyListeners) {
        listener(nextReady);
      }
    }
    return nextReady;
  }

  async *query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    this.turnMetadata = {};
    this.canceled = false;

    const cli = this.plugin.getResolvedProviderCliPath('cursor');
    if (!cli) {
      yield { type: 'error', content: 'Cursor Agent CLI not found. Configure it in Cursor settings.' };
      yield { type: 'done' };
      return;
    }

    const workspaceDir = getVaultPath(this.plugin.app) ?? process.cwd();
    const permissionMode = this.plugin.settings.permissionMode as CursorPermissionMode;
    const model = resolveCursorModelForCli(
      queryOptions?.model ?? this.resolveProviderModel(),
    );
    const resumeId = this.activeResumeId;

    yield {
      type: 'user_message_start',
      content: turn.persistedContent,
    };
    yield { type: 'assistant_message_start' };

    const flagArgs = buildCursorAgentFlagArgs({
      workspaceDir,
      model,
      permissionMode,
      resumeSessionId: resumeId,
      approveMcps: (turn.request.enabledMcpServers?.size ?? 0) > 0,
    });

    const env = buildCursorAgentEnvironment(this.plugin);
    const reducer = new CursorNdjsonStreamReducer();
    let sawDone = false;
    const child = spawn(cli, [...flagArgs, turn.prompt], {
      cwd: workspaceDir,
      env,
      windowsHide: true,
    });
    this.child = child;

    let stderrAcc = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrAcc += d.toString('utf8');
    });

    const rl = readline.createInterface({ input: child.stdout });

    try {
      for await (const line of rl) {
        if (this.canceled) {
          break;
        }
        const { chunks, sessionId } = reducer.reduceLine(line);
        if (sessionId) {
          this.lastSessionId = sessionId;
        }
        for (const chunk of chunks) {
          if (chunk.type === 'done') {
            sawDone = true;
          }
          yield chunk;
        }
      }
    } finally {
      rl.close();
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
    });

    const stderrText = stderrAcc;
    this.child = null;

    if (this.canceled) {
      if (!sawDone) {
        yield { type: 'done' };
      }
      return;
    }

    if (exitCode !== 0) {
      if (!sawDone) {
        const msg = stderrText.trim() || `Cursor Agent exited with code ${exitCode}`;
        yield { type: 'error', content: msg };
        yield { type: 'done' };
      }
      return;
    }

    if (!sawDone) {
      yield {
        type: 'error',
        content: stderrText.trim() || 'Cursor Agent finished without a terminal result event',
      };
      yield { type: 'done' };
    }

    if (this.lastSessionId) {
      this.activeResumeId = this.lastSessionId;
    }
  }

  cancel(): void {
    this.canceled = true;
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  resetSession(): void {
    this.lastSessionId = null;
    this.activeResumeId = null;
  }

  getSessionId(): string | null {
    return this.lastSessionId;
  }

  consumeSessionInvalidation(): boolean {
    return false;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  cleanup(): void {
    this.cancel();
    this.readyListeners.clear();
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string,
  ): Promise<ChatRewindResult> {
    return { canRewind: false, error: 'Cursor Agent does not support rewind' };
  }

  setApprovalCallback(_callback: ApprovalCallback | null): void {}

  setApprovalDismisser(_dismisser: (() => void) | null): void {}

  setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void {}

  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {}

  setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void {}

  setSubagentHookProvider(_getState: () => SubagentRuntimeState): void {}

  setAutoTurnCallback(_callback: ((result: AutoTurnResult) => void) | null): void {}

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    if (params.sessionInvalidated && params.conversation) {
      return {
        updates: {
          sessionId: null,
          providerState: undefined,
        },
      };
    }

    const sid = this.lastSessionId;
    const existing = params.conversation ? getCursorState(params.conversation.providerState) : {};
    const providerState: Record<string, unknown> = { ...existing };
    if (sid) {
      providerState.chatSessionId = sid;
    }

    return {
      updates: {
        sessionId: sid,
        providerState: Object.keys(providerState).length > 0 ? providerState : undefined,
      },
    };
  }

  resolveSessionIdForFork(_conversation: Conversation | null): string | null {
    return null;
  }

  private resolveProviderModel(): string | undefined {
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      'cursor',
    );
    const m = providerSettings.model;
    return typeof m === 'string' && m.trim() ? m.trim() : undefined;
  }
}
