import {
  Codex,
  type ModelReasoningEffort,
  type ThreadEvent,
  type ThreadOptions,
} from '@openai/codex-sdk';

import { ProviderSettingsCoordinator } from '../../../core/providers';
import type { ProviderCapabilities, ProviderId } from '../../../core/providers/types';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  ChatRewindResult,
  ChatRuntime,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnRequest,
  ExitPlanModeCallback,
  PreparedChatTurn,
  SessionUpdateResult,
  SubagentRuntimeState,
} from '../../../core/runtime';
import type { ChatMessage, Conversation, SlashCommand, StreamChunk, UsageInfo } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { CODEX_PROVIDER_CAPABILITIES } from '../capabilities';
import { findCodexSessionFile } from '../history/CodexHistoryStore';
import { encodeCodexTurn } from '../prompt/encodeCodexTurn';
import { type CodexProviderState, getCodexState } from '../types';
import { CodexSessionManager } from './CodexSessionManager';

const DEFAULT_CONTEXT_WINDOW = 200_000;

const EFFORT_MAP: Record<string, ModelReasoningEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

export class CodexChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'codex';

  private plugin: ClaudianPlugin;
  private session = new CodexSessionManager();
  private codex: Codex | null = null;
  private abortController: AbortController | null = null;
  private ready = false;
  private readyListeners = new Set<(ready: boolean) => void>();
  private lastTextPositions = new Map<string, number>();

  /* eslint-disable @typescript-eslint/no-unused-vars */
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private subagentHookProvider: (() => SubagentRuntimeState) | null = null;
  private autoTurnCallback: ((chunks: StreamChunk[]) => void) | null = null;
  private resumeCheckpoint: string | undefined;
  /* eslint-enable @typescript-eslint/no-unused-vars */

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return CODEX_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return encodeCodexTurn(request);
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  setResumeCheckpoint(checkpointId: string | undefined): void {
    this.resumeCheckpoint = checkpointId;
  }

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    _externalContextPaths?: string[],
  ): void {
    if (!conversation) {
      this.session.reset();
      return;
    }

    const state = getCodexState(conversation.providerState);
    const threadId = state.threadId ?? conversation.sessionId ?? null;

    if (!threadId) {
      this.session.reset();
      return;
    }

    this.session.setThread(threadId, state.sessionFilePath);
  }

  async reloadMcpServers(): Promise<void> {
    // No-op: Codex handles MCP internally
  }

  async ensureReady(_options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    if (!this.codex) {
      const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
      const baseEnv = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      this.codex = new Codex({
        env: {
          ...baseEnv,
          ...customEnv,
        },
      });
    }
    this.setReady(true);
    return true;
  }

  async *query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    if (turn.request.images && turn.request.images.length > 0) {
      yield { type: 'error', content: 'Codex does not support image attachments' };
      yield { type: 'done' };
      return;
    }

    await this.ensureReady();

    this.abortController = new AbortController();
    this.lastTextPositions.clear();

    const externalContextPaths = turn.request.externalContextPaths ?? queryOptions?.externalContextPaths;
    const threadOptions = this.buildThreadOptions(queryOptions, externalContextPaths);

    const thread = this.session.getThreadId()
      ? this.codex!.resumeThread(this.session.getThreadId()!, threadOptions)
      : this.codex!.startThread(threadOptions);

    try {
      const { events } = await thread.runStreamed(turn.prompt, {
        signal: this.abortController.signal,
      });

      for await (const event of events) {
        const chunks = this.mapEvent(event);
        for (const chunk of chunks) {
          yield chunk;
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        yield { type: 'done' };
        return;
      }
      const message = err instanceof Error ? err.message : 'Unknown Codex error';
      yield { type: 'error', content: message };
      yield { type: 'done' };
    }
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  resetSession(): void {
    this.session.reset();
    this.codex = null;
    this.setReady(false);
  }

  getSessionId(): string | null {
    return this.session.getThreadId();
  }

  consumeSessionInvalidation(): boolean {
    return this.session.consumeInvalidation();
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  cleanup(): void {
    this.cancel();
    this.session.reset();
    this.codex = null;
    this.setReady(false);
    this.readyListeners.clear();
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string,
  ): Promise<ChatRewindResult> {
    return { canRewind: false, error: 'Codex does not support rewind' };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setSubagentHookProvider(getState: () => SubagentRuntimeState): void {
    this.subagentHookProvider = getState;
  }

  setAutoTurnCallback(callback: ((chunks: StreamChunk[]) => void) | null): void {
    this.autoTurnCallback = callback;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const threadId = this.session.getThreadId();
    const sessionFilePath = this.session.getSessionFilePath();

    const providerState: CodexProviderState = {
      ...(threadId ? { threadId } : {}),
      ...(sessionFilePath ? { sessionFilePath } : {}),
    };

    const updates: Partial<Conversation> = {
      sessionId: threadId,
      providerState: providerState as Record<string, unknown>,
    };

    if (params.sessionInvalidated && params.conversation) {
      updates.sessionId = null;
      updates.providerState = undefined;
    }

    return { updates };
  }

  resolveSessionIdForFork(_conversation: Conversation | null): string | null {
    return null;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private setReady(ready: boolean): void {
    this.ready = ready;
    for (const listener of this.readyListeners) {
      listener(ready);
    }
  }

  private buildThreadOptions(
    queryOptions?: ChatRuntimeQueryOptions,
    additionalDirectories?: string[],
  ): ThreadOptions {
    const vaultPath = getVaultPath(this.plugin.app);
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      this.providerId,
    );
    const model = queryOptions?.model ?? providerSettings.model as string;
    const effort = EFFORT_MAP[providerSettings.effortLevel as string] ?? 'medium';

    return {
      model,
      workingDirectory: vaultPath ?? undefined,
      sandboxMode: 'workspace-write',
      modelReasoningEffort: effort,
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      additionalDirectories,
    };
  }

  private mapEvent(event: ThreadEvent): StreamChunk[] {
    const chunks: StreamChunk[] = [];

    switch (event.type) {
      case 'thread.started':
        if (event.thread_id) {
          this.session.setThread(event.thread_id);
        }
        break;

      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.mapItemEvent(event, chunks);
        break;

      case 'turn.completed':
        if (!this.session.getSessionFilePath()) {
          const threadId = this.session.getThreadId();
          if (threadId) {
            const sessionFilePath = findCodexSessionFile(threadId);
            if (sessionFilePath) {
              this.session.setThread(threadId, sessionFilePath);
            }
          }
        }
        if (event.usage) {
          const usage = this.mapUsage(event.usage);
          chunks.push({ type: 'usage', usage, sessionId: this.session.getThreadId() });
        }
        chunks.push({ type: 'done' });
        break;

      case 'turn.failed':
        if (event.error) {
          chunks.push({ type: 'error', content: event.error.message });
        }
        chunks.push({ type: 'done' });
        break;

      case 'error':
        chunks.push({ type: 'error', content: (event as { message?: string }).message ?? 'Unknown error' });
        break;

      default:
        // Gracefully ignore unknown event types
        break;
    }

    return chunks;
  }

  private mapItemEvent(
    event: ThreadEvent & { item: { id: string; type: string } },
    chunks: StreamChunk[],
  ): void {
    const item = (event as { item: Record<string, unknown> }).item;
    const itemId = item.id as string;
    const itemType = item.type as string;

    switch (itemType) {
      case 'agent_message':
        this.emitTextDelta(itemId, item.text as string | undefined, 'text', chunks);
        break;

      case 'reasoning':
        this.emitTextDelta(itemId, item.text as string | undefined, 'thinking', chunks);
        break;

      case 'command_execution':
        if (event.type === 'item.started') {
          chunks.push({
            type: 'tool_use',
            id: itemId,
            name: 'Bash',
            input: { command: item.command ?? '' },
          });
        } else if (event.type === 'item.completed') {
          chunks.push({
            type: 'tool_result',
            id: itemId,
            content: (item.aggregated_output as string) ?? '',
            isError: (item.exit_code as number | undefined) !== 0 &&
              (item.exit_code as number | undefined) !== undefined,
          });
        }
        break;

      case 'file_change': {
        const changes = (item.changes as Array<{ path: string; kind: string }>) ?? [];
        if (event.type === 'item.started') {
          chunks.push({
            type: 'tool_use',
            id: itemId,
            name: 'apply_patch',
            input: { changes },
          });
        } else if (event.type === 'item.completed') {
          const paths = changes.map(c => `${c.kind}: ${c.path}`).join(', ');
          chunks.push({
            type: 'tool_result',
            id: itemId,
            content: paths ? `Applied: ${paths}` : 'Applied',
            isError: (item.status as string) === 'failed',
          });
        }
        break;
      }

      case 'web_search':
        if (event.type === 'item.started') {
          chunks.push({
            type: 'tool_use',
            id: itemId,
            name: 'WebSearch',
            input: { query: item.query ?? '' },
          });
        } else if (event.type === 'item.completed') {
          chunks.push({
            type: 'tool_result',
            id: itemId,
            content: 'Search complete',
          });
        }
        break;

      case 'mcp_tool_call':
        if (event.type === 'item.started') {
          const server = (item.server as string) ?? '';
          const tool = (item.tool as string) ?? '';
          chunks.push({
            type: 'tool_use',
            id: itemId,
            name: `mcp__${server}__${tool}`,
            input: (item.arguments ?? {}) as Record<string, unknown>,
          });
        } else if (event.type === 'item.completed') {
          const error = item.error as { message: string } | undefined;
          if (error) {
            chunks.push({
              type: 'tool_result',
              id: itemId,
              content: error.message,
              isError: true,
            });
          } else {
            chunks.push({
              type: 'tool_result',
              id: itemId,
              content: 'Completed',
            });
          }
        }
        break;

      case 'todo_list':
        // Todo lists are informational; no StreamChunk mapping needed
        break;

      case 'error':
        chunks.push({
          type: 'error',
          content: (item.message as string) ?? 'Unknown item error',
        });
        break;

      default:
        // Gracefully ignore unknown item types
        break;
    }
  }

  private emitTextDelta(
    itemId: string,
    fullText: string | undefined,
    chunkType: 'text' | 'thinking',
    chunks: StreamChunk[],
  ): void {
    if (!fullText) return;

    const lastPos = this.lastTextPositions.get(itemId) ?? 0;
    if (fullText.length > lastPos) {
      const delta = fullText.slice(lastPos);
      this.lastTextPositions.set(itemId, fullText.length);
      chunks.push({ type: chunkType, content: delta });
    }
  }

  private mapUsage(sdkUsage: { input_tokens: number; cached_input_tokens: number; output_tokens: number }): UsageInfo {
    const contextTokens = sdkUsage.input_tokens + sdkUsage.cached_input_tokens;
    const contextWindow = DEFAULT_CONTEXT_WINDOW;
    return {
      inputTokens: sdkUsage.input_tokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: sdkUsage.cached_input_tokens,
      contextWindow,
      contextTokens,
      percentage: contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0,
    };
  }
}
