/**
 * Geminian - Gemini CLI Service
 *
 * Handles communication with Gemini via direct CLI subprocess spawning.
 * Each query spawns a new `gemini` process with --output-format stream-json.
 * Session continuity is maintained via --resume flag.
 */

import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

import type GeminianPlugin from '../../main';
import { stripCurrentNoteContext } from '../../utils/context';
import { getEnhancedPath, getMissingNodeError, parseEnvironmentVariables } from '../../utils/env';
import { getVaultPath } from '../../utils/path';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
} from '../../utils/session';
import type { McpServerManager } from '../mcp';
import { isSessionInitEvent, isStreamChunk, parseGeminiJsonLine,transformGeminiEvent } from '../sdk';
import type {
  ApprovalDecision,
  ChatMessage,
  Conversation,
  ExitPlanModeCallback,
  ImageAttachment,
  SlashCommand,
  StreamChunk,
} from '../types';
import { spawnGeminiCli } from './customSpawn';
import {
  type ColdStartQueryContext,
  QueryOptionsBuilder,
  type QueryOptionsContext,
} from './QueryOptionsBuilder';
import { SessionManager } from './SessionManager';

export type { ApprovalDecision };

export interface ApprovalCallbackOptions {
  decisionReason?: string;
  blockedPath?: string;
  agentID?: string;
}

export type ApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>,
  description: string,
  options?: ApprovalCallbackOptions,
) => Promise<ApprovalDecision>;

export type AskUserQuestionCallback = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, string> | null>;

export interface QueryOptions {
  allowedTools?: string[];
  model?: string;
  mcpMentions?: Set<string>;
  enabledMcpServers?: Set<string>;
  forceColdStart?: boolean;
  externalContextPaths?: string[];
}

export interface EnsureReadyOptions {
  sessionId?: string;
  externalContextPaths?: string[];
  force?: boolean;
  preserveHandlers?: boolean;
}

export class GeminianService {
  private plugin: GeminianPlugin;
  private abortController: AbortController | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private vaultPath: string | null = null;
  private currentExternalContextPaths: string[] = [];
  private readyStateListeners = new Set<(ready: boolean) => void>();
  private sessionManager = new SessionManager();
  private mcpManager: McpServerManager;
  private currentProcess: ChildProcess | null = null;
  private ready = false;

  constructor(plugin: GeminianPlugin, mcpManager: McpServerManager) {
    this.plugin = plugin;
    this.mcpManager = mcpManager;
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyStateListeners.add(listener);
    try {
      listener(this.isReady());
    } catch {
      // Ignore listener errors
    }
    return () => {
      this.readyStateListeners.delete(listener);
    };
  }

  private notifyReadyStateChange(): void {
    const isReady = this.isReady();
    for (const listener of this.readyStateListeners) {
      try {
        listener(isReady);
      } catch {
        // Ignore listener errors
      }
    }
  }

  async reloadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  setPendingResumeAt(_uuid: string | undefined): void {
    // No-op for Gemini CLI (no rewind support)
  }

  applyForkState(conv: Pick<Conversation, 'sessionId' | 'sdkSessionId' | 'forkSource'>): string | null {
    return conv.sessionId ?? conv.forkSource?.sessionId ?? null;
  }

  async ensureReady(options?: EnsureReadyOptions): Promise<boolean> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) return false;

    const cliPath = this.plugin.getResolvedGeminiCliPath();
    if (!cliPath) return false;

    if (options?.sessionId) {
      this.sessionManager.setSessionId(options.sessionId, this.plugin.settings.model);
    }

    if (options?.externalContextPaths !== undefined) {
      this.currentExternalContextPaths = options.externalContextPaths;
    }

    this.vaultPath = vaultPath;
    this.ready = true;
    this.notifyReadyStateChange();
    return true;
  }

  isPersistentQueryActive(): boolean {
    return this.currentProcess !== null;
  }

  isReady(): boolean {
    return this.ready;
  }

  closePersistentQuery(_reason?: string): void {
    if (this.currentProcess) {
      try {
        this.currentProcess.kill();
      } catch {
        // Process may already be dead
      }
      this.currentProcess = null;
    }
  }

  private getTransformOptions(modelOverride?: string) {
    return {
      intendedModel: modelOverride ?? this.plugin.settings.model,
      customContextLimits: this.plugin.settings.customContextLimits,
    };
  }

  async *query(
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      yield { type: 'error', content: 'Could not determine vault path' };
      return;
    }

    const resolvedCliPath = this.plugin.getResolvedGeminiCliPath();
    if (!resolvedCliPath) {
      yield { type: 'error', content: 'Gemini CLI not found. Please install Gemini CLI: npm install -g @google/gemini-cli' };
      return;
    }

    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const enhancedPath = getEnhancedPath(customEnv.PATH, resolvedCliPath);

    if (resolvedCliPath.endsWith('.js')) {
      const missingNodeError = getMissingNodeError(resolvedCliPath, enhancedPath);
      if (missingNodeError) {
        yield { type: 'error', content: missingNodeError };
        return;
      }
    }

    this.vaultPath = vaultPath;

    let promptToSend = prompt;

    // Session mismatch recovery: rebuild history context if SDK gave us a different session
    if (this.sessionManager.needsHistoryRebuild() && conversationHistory && conversationHistory.length > 0) {
      const historyContext = buildContextFromHistory(conversationHistory);
      const actualPrompt = stripCurrentNoteContext(prompt);
      promptToSend = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory);
      this.sessionManager.clearHistoryRebuild();
    }

    // No session yet but has conversation history — include context for continuity
    const noSessionButHasHistory = !this.sessionManager.getSessionId() &&
      conversationHistory && conversationHistory.length > 0;

    if (noSessionButHasHistory) {
      const historyContext = buildContextFromHistory(conversationHistory!);
      const actualPrompt = stripCurrentNoteContext(prompt);
      promptToSend = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory!);
    }

    // Write image attachments to temp files and reference them in the prompt
    if (images && images.length > 0) {
      const imagePromptParts: string[] = [];
      for (const image of images) {
        const ext = image.mediaType.split('/')[1] || 'png';
        const tmpFile = path.join(os.tmpdir(), `geminian-${randomUUID()}.${ext}`);
        const buffer = Buffer.from(image.data, 'base64');
        await fs.promises.writeFile(tmpFile, buffer);
        imagePromptParts.push(`[Image: ${tmpFile}]`);
      }
      promptToSend = imagePromptParts.join('\n') + '\n' + promptToSend;
    }

    const selectedModel = queryOptions?.model || this.plugin.settings.model;
    const baseContext: QueryOptionsContext = {
      vaultPath,
      cliPath: resolvedCliPath,
      settings: this.plugin.settings,
      customEnv,
      enhancedPath,
      mcpManager: this.mcpManager,
      pluginManager: this.plugin.pluginManager,
    };

    const ctx: ColdStartQueryContext = {
      ...baseContext,
      abortController: this.abortController ?? undefined,
      sessionId: this.sessionManager.getSessionId() ?? undefined,
      modelOverride: queryOptions?.model,
      mcpMentions: queryOptions?.mcpMentions,
      enabledMcpServers: queryOptions?.enabledMcpServers,
      allowedTools: queryOptions?.allowedTools,
      hasEditorContext: prompt.includes('<editor_selection'),
      externalContextPaths: queryOptions?.externalContextPaths || this.currentExternalContextPaths,
    };

    const cliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, promptToSend);
    this.sessionManager.setPendingModel(selectedModel);

    this.abortController = new AbortController();

    try {
      yield* this.spawnAndStream(cliArgs, selectedModel);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    } finally {
      this.sessionManager.clearPendingModel();
      this.abortController = null;
      this.currentProcess = null;
    }

    yield { type: 'done' };
  }

  private async *spawnAndStream(
    cliArgs: ReturnType<typeof QueryOptionsBuilder.buildColdStartCliArgs>,
    selectedModel: string
  ): AsyncGenerator<StreamChunk> {
    const child = spawnGeminiCli({
      cliPath: cliArgs.cliPath,
      args: cliArgs.args,
      cwd: cliArgs.cwd,
      env: cliArgs.env,
      signal: this.abortController?.signal,
      enhancedPath: cliArgs.env.PATH as string,
    });

    this.currentProcess = child;
    this.notifyReadyStateChange();

    if (!child.stdout) {
      throw new Error('Failed to create Gemini CLI process stdout');
    }

    let stderrData = '';
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        stderrData += data.toString();
      });
    }

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    const transformOptions = this.getTransformOptions(selectedModel);

    try {
      for await (const line of rl) {
        if (this.abortController?.signal.aborted) break;

        const geminiEvent = parseGeminiJsonLine(line);
        if (!geminiEvent) continue;

        for (const event of transformGeminiEvent(geminiEvent, transformOptions)) {
          if (isSessionInitEvent(event)) {
            this.sessionManager.captureSession(event.sessionId);
          } else if (isStreamChunk(event)) {
            if (event.type === 'usage') {
              yield { ...event, sessionId: this.sessionManager.getSessionId() };
            } else {
              yield event;
            }
          }
        }
      }
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        return;
      }
      throw error;
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
        return;
      }
      child.on('exit', (code: number | null) => resolve(code));
      child.on('error', () => resolve(null));
    });

    if (exitCode !== null && exitCode !== 0 && !this.abortController?.signal.aborted) {
      const errorMsg = stderrData.trim() || `Gemini CLI exited with code ${exitCode}`;
      yield { type: 'error', content: errorMsg };
    }

    this.currentProcess = null;
    this.notifyReadyStateChange();
  }

  cancel() {
    this.approvalDismisser?.();

    if (this.abortController) {
      this.abortController.abort();
      this.sessionManager.markInterrupted();
    }

    if (this.currentProcess) {
      try {
        this.currentProcess.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
    }
  }

  resetSession() {
    this.closePersistentQuery('session reset');
    this.sessionManager.reset();
  }

  getSessionId(): string | null {
    return this.sessionManager.getSessionId();
  }

  consumeSessionInvalidation(): boolean {
    return this.sessionManager.consumeInvalidation();
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  setSessionId(id: string | null, externalContextPaths?: string[]): void {
    this.sessionManager.setSessionId(id, this.plugin.settings.model);
    if (externalContextPaths !== undefined) {
      this.currentExternalContextPaths = externalContextPaths;
    }
    this.ensureReady({
      sessionId: id ?? undefined,
      externalContextPaths,
    }).catch(() => {
      // Best-effort
    });
  }

  cleanup() {
    this.closePersistentQuery('plugin cleanup');
    this.cancel();
    this.resetSession();
  }

  async rewindFiles(_sdkUserUuid: string, _dryRun?: boolean): Promise<{ canRewind: boolean }> {
    return { canRewind: false };
  }

  async rewind(_sdkUserUuid: string, _sdkAssistantUuid: string): Promise<{ canRewind: boolean }> {
    return { canRewind: false };
  }

  setApprovalCallback(callback: ApprovalCallback | null) {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null) {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null) {
    this.askUserQuestionCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }
}
