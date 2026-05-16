import { spawn } from 'child_process';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderCapabilities, ProviderId } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnCallback,
  ChatRewindMode,
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
import { getHostnameKey } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { CURSOR_PROVIDER_CAPABILITIES } from '../capabilities';
import {
  createCursorNormalizationState,
  type CursorNormalizationContext,
  type CursorNormalizationState,
  normalizeCursorEvent,
} from '../normalization/cursorEventNormalization';
import { encodeCursorTurn } from '../prompt/encodeCursorTurn';
import { getCursorProviderSettings } from '../settings';
import { getCursorState } from '../types';
import { CursorAgentProcess } from './CursorAgentProcess';
import { resolveCursorCliPath } from './CursorBinaryLocator';
import { CursorEventTransport } from './CursorEventTransport';
import {
  buildCursorCreateChatLaunchSpec,
  buildCursorLaunchSpec,
} from './CursorLaunchSpecBuilder';

const CREATE_CHAT_TIMEOUT_MS = 30_000;

/**
 * Real Phase 2 runtime. Each turn is a one-shot `cursor-agent` invocation.
 * The thread id returned from `cursor-agent create-chat` (or surfaced as
 * `session_id` in the streaming events) is persisted in
 * `CursorProviderState.threadId` and reused via `--resume` on subsequent
 * turns to preserve conversation continuity.
 */
export class CursorChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'cursor';

  private readonly plugin: ClaudianPlugin;
  private threadId: string | null = null;
  private sessionInvalidated = false;
  private currentProcess: CursorAgentProcess | null = null;
  private currentTransport: CursorEventTransport | null = null;
  private canceled = false;
  private turnMetadata: ChatTurnMetadata = {};
  private readyListeners = new Set<(ready: boolean) => void>();

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return CURSOR_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return encodeCursorTurn(request);
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {
    // Resume-from-checkpoint is not supported; turns always continue from the
    // current Cursor thread tail.
  }

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    _externalContextPaths?: string[],
  ): void {
    if (!conversation) {
      this.threadId = null;
      return;
    }

    const state = getCursorState(conversation.providerState);
    this.threadId = state.threadId ?? conversation.sessionId ?? null;
  }

  async reloadMcpServers(): Promise<void> {
    // MCP not supported by Cursor MVP.
  }

  async ensureReady(_options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    const cliPath = this.resolveCliPath();
    return cliPath !== null;
  }

  async *query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    this.canceled = false;
    this.turnMetadata = {};

    const cliPath = this.resolveCliPath();
    if (!cliPath) {
      yield {
        type: 'error',
        content: 'Cursor agent CLI not found. Set the path in Settings → Cursor or install `cursor-agent` on PATH.',
      };
      yield { type: 'done' };
      return;
    }

    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const envText = getRuntimeEnvironmentText(settings, 'cursor');
    const workspaceCwd = this.resolveWorkspaceCwd();
    const model = this.resolveModelId(queryOptions?.model);

    if (!this.threadId) {
      try {
        this.threadId = await this.createNewChat(cliPath, envText, workspaceCwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield {
          type: 'error',
          content: `Failed to create Cursor chat session: ${message}`,
        };
        yield { type: 'done' };
        return;
      }
    }

    if (this.canceled) {
      yield { type: 'error', content: 'Cancelled' };
      yield { type: 'done' };
      return;
    }

    const launchSpec = buildCursorLaunchSpec({
      cliPath,
      prompt: turn.prompt,
      envText,
      workspaceCwd,
      threadId: this.threadId ?? undefined,
      model,
    });

    const proc = new CursorAgentProcess(launchSpec);
    const transport = new CursorEventTransport(proc.stdout);
    this.currentProcess = proc;
    this.currentTransport = transport;

    const state = createCursorNormalizationState();
    state.sessionId = this.threadId;
    const normalizationContext: CursorNormalizationContext = {
      modelHint: model,
    };

    const buffer: StreamChunk[] = [];
    let bufferResolve: (() => void) | null = null;
    const flushNotify = (): void => {
      const resolver = bufferResolve;
      bufferResolve = null;
      resolver?.();
    };

    const drainEvent = transport.onEvent((event) => {
      const chunks = normalizeCursorEvent(event, state, normalizationContext);
      if (chunks.length > 0) {
        buffer.push(...chunks);
        flushNotify();
      }
    });

    const drainClose = transport.onClose(() => {
      flushNotify();
    });

    const drainParseError = (): void => {
      // Swallow parse errors; cursor-agent occasionally interleaves blank
      // lines or non-JSON diagnostics that are safe to ignore.
    };
    transport.onParseError(drainParseError);

    let stderrBuffer = '';
    proc.stderr.on('data', (data: Buffer) => {
      stderrBuffer += data.toString('utf-8');
    });

    let processExitCode: number | null = null;
    let processExitSignal: NodeJS.Signals | null = null;
    proc.onExit((code, signal) => {
      processExitCode = code;
      processExitSignal = signal;
      flushNotify();
    });

    proc.start();
    transport.start();

    try {
      while (true) {
        if (buffer.length > 0) {
          const chunk = buffer.shift()!;
          yield chunk;
          if (chunk.type === 'done') {
            break;
          }
          continue;
        }

        if (state.done) {
          break;
        }

        if (this.canceled) {
          buffer.push({ type: 'error', content: 'Cancelled' }, { type: 'done' });
          continue;
        }

        if (!proc.isAlive() && processExitCode !== null) {
          // Process ended without a `result` event — surface stderr if any.
          if (!state.done) {
            const trimmedStderr = stderrBuffer.trim();
            const exitMessage = trimmedStderr
              || `cursor-agent exited (code=${processExitCode}, signal=${processExitSignal ?? 'none'})`;
            buffer.push({ type: 'error', content: exitMessage });
            buffer.push({ type: 'done' });
            state.done = true;
            continue;
          }
        }

        await new Promise<void>((resolve) => {
          bufferResolve = resolve;
        });
      }
    } finally {
      drainEvent();
      drainClose();
      transport.dispose();
      this.currentProcess = null;
      this.currentTransport = null;

      if (proc.isAlive()) {
        await proc.shutdown();
      }
    }

    this.recordTurnMetadata(state);
    if (state.sessionId) {
      this.threadId = state.sessionId;
    }
  }

  cancel(): void {
    this.canceled = true;
    if (this.currentProcess?.isAlive()) {
      void this.currentProcess.shutdown();
    }
  }

  resetSession(): void {
    this.threadId = null;
    this.sessionInvalidated = true;
  }

  getSessionId(): string | null {
    return this.threadId;
  }

  consumeSessionInvalidation(): boolean {
    const value = this.sessionInvalidated;
    this.sessionInvalidated = false;
    return value;
  }

  isReady(): boolean {
    return this.resolveCliPath() !== null;
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
    _mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    return {
      canRewind: false,
      error: 'Rewind is not supported by the Cursor provider.',
    };
  }

  setApprovalCallback(_callback: ApprovalCallback | null): void {
    // No approval flow surfaced from the streaming output; tools auto-run via `--force`.
  }

  setApprovalDismisser(_dismisser: (() => void) | null): void {}

  setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void {}

  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {}

  setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void {}

  setSubagentHookProvider(_getState: () => SubagentRuntimeState): void {}

  setAutoTurnCallback(_callback: AutoTurnCallback | null): void {}

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = { ...this.turnMetadata };
    this.turnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    if (params.sessionInvalidated) {
      return {
        updates: {
          sessionId: null,
          providerState: undefined,
        },
      };
    }

    if (!params.conversation || !this.threadId) {
      return { updates: {} };
    }

    const state = getCursorState(params.conversation.providerState);
    if (state.threadId === this.threadId) {
      return { updates: {} };
    }

    return {
      updates: {
        sessionId: this.threadId,
        providerState: { ...(params.conversation.providerState ?? {}), threadId: this.threadId },
      },
    };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    if (!conversation) {
      return null;
    }
    const state = getCursorState(conversation.providerState);
    return state.threadId ?? conversation.sessionId ?? null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private resolveCliPath(): string | null {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const cursorSettings = getCursorProviderSettings(settings);
    const hostnamePath = cursorSettings.cliPathsByHost[getHostnameKey()] ?? '';
    const envText = getRuntimeEnvironmentText(settings, 'cursor');
    return resolveCursorCliPath(hostnamePath, cursorSettings.cliPath, envText);
  }

  private resolveWorkspaceCwd(): string | undefined {
    try {
      return getVaultPath(this.plugin.app) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private resolveModelId(explicit?: string): string | undefined {
    if (explicit && explicit.trim()) {
      return explicit.trim();
    }
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings,
      'cursor',
    );
    const modelFromSnapshot = (providerSettings as { model?: string } | undefined)?.model;
    if (typeof modelFromSnapshot === 'string' && modelFromSnapshot.trim()) {
      return modelFromSnapshot.trim();
    }
    const fallback = (this.plugin.settings as unknown as Record<string, unknown>).model;
    return typeof fallback === 'string' && fallback.trim() ? fallback.trim() : undefined;
  }

  private async createNewChat(
    cliPath: string,
    envText: string,
    workspaceCwd: string | undefined,
  ): Promise<string> {
    const launchSpec = buildCursorCreateChatLaunchSpec({
      cliPath,
      envText,
      workspaceCwd,
    });

    return new Promise<string>((resolve, reject) => {
      const child = spawn(launchSpec.command, launchSpec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: launchSpec.spawnCwd,
        env: launchSpec.env,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const startedAt = Date.now();

      const settle = (
        kind: 'resolve' | 'reject',
        valueOrError: string | Error,
      ): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (kind === 'resolve') {
          resolve(valueOrError as string);
        } else {
          reject(valueOrError as Error);
        }
      };

      const buildDiagnostic = (label: string): string => {
        const elapsed = Date.now() - startedAt;
        const pathHint = (launchSpec.env.PATH ?? '').split(/[:;]/).slice(0, 6).join(':');
        const stdoutSnippet = stdout.trim().slice(0, 200);
        const stderrSnippet = stderr.trim().slice(0, 400);
        const parts = [
          label,
          `cli=${launchSpec.command}`,
          `cwd=${launchSpec.spawnCwd ?? '(inherit)'}`,
          `elapsed=${elapsed}ms`,
        ];
        if (pathHint) parts.push(`PATH[0..6]=${pathHint}`);
        if (stdoutSnippet) parts.push(`stdout=${stdoutSnippet}`);
        if (stderrSnippet) parts.push(`stderr=${stderrSnippet}`);
        return parts.join(' | ');
      };

      const timer = window.setTimeout(() => {
        child.kill('SIGKILL');
        settle('reject', new Error(buildDiagnostic('cursor-agent create-chat timed out')));
      }, CREATE_CHAT_TIMEOUT_MS);

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString('utf-8');
      });
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString('utf-8');
      });
      child.on('error', (error) => {
        settle('reject', new Error(buildDiagnostic(`cursor-agent create-chat spawn error: ${error.message}`)));
      });
      // Use 'close' (fires after stdout/stderr drain) instead of 'exit' to
      // avoid a race where the last chunk of stdout arrives after exit.
      child.on('close', (code) => {
        if (code !== 0) {
          settle('reject', new Error(buildDiagnostic(`cursor-agent create-chat exited with code ${code}`)));
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          settle('reject', new Error(buildDiagnostic('cursor-agent create-chat returned no output')));
          return;
        }
        const lastLine = trimmed.split(/\r?\n/).filter(Boolean).pop() ?? '';
        if (!lastLine) {
          settle('reject', new Error(buildDiagnostic('cursor-agent create-chat returned no session id line')));
          return;
        }
        settle('resolve', lastLine);
      });
    });
  }

  private recordTurnMetadata(state: CursorNormalizationState): void {
    this.turnMetadata = {
      wasSent: !state.errorMessage,
    };
  }
}
