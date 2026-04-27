import { randomUUID } from 'crypto';

import { buildSystemPrompt, computeSystemPromptKey, type SystemPromptSettings } from '../../../core/prompt/mainAgent';
import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderCapabilities } from '../../../core/providers/types';
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
import type { ChatMessage, Conversation, StreamChunk, ToolCallInfo } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';
import { GEMINI_PROVIDER_CAPABILITIES } from '../capabilities';
import { encodeGeminiTurn } from '../prompt/encodeGeminiTurn';
import { getGeminiProviderSettings } from '../settings';
import {
  describeGeminiWriteTool,
  executeGeminiVaultTool,
  GEMINI_VAULT_TOOL_APPENDIX,
  GEMINI_VAULT_TOOL_DECLARATIONS,
  isGeminiWriteTool,
} from '../tools/GeminiVaultTools';
import { DEFAULT_GEMINI_CONTEXT_WINDOW, DEFAULT_GEMINI_PRIMARY_MODEL } from '../types/models';
import {
  GeminiApiClient,
  type GeminiContent,
  type GeminiFunctionCall,
  type GeminiFunctionResponsePart,
  type GeminiPart,
  type GeminiUsageMetadata,
} from './GeminiApiClient';

const MAX_TOOL_ROUNDS = 8;
const GEMINI_SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);


export class GeminiChatRuntime implements ChatRuntime {
  readonly providerId = 'gemini';

  private plugin: ClaudianPlugin;
  private ready = false;
  private readyListeners = new Set<(ready: boolean) => void>();
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private turnMetadata: ChatTurnMetadata = {};
  private clientConfigKey = '';

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return GEMINI_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return encodeGeminiTurn(request);
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {}

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    _externalContextPaths?: string[],
  ): void {
    this.sessionId = conversation?.sessionId ?? null;
  }

  async reloadMcpServers(): Promise<void> {}

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    if (options?.sessionId) {
      this.sessionId = options.sessionId;
    }

    const nextKey = computeSystemPromptKey(this.getSystemPromptSettings());
    const rebuilt = options?.force === true || this.clientConfigKey !== nextKey;
    this.clientConfigKey = nextKey;
    this.setReady(true);
    return rebuilt;
  }

  async *query(
    turn: PreparedChatTurn,
    conversationHistory: ChatMessage[] = [],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    this.resetTurnMetadata();
    this.abortController = new AbortController();
    this.turnMetadata.wasSent = true;

    if (!this.sessionId) {
      this.sessionId = randomUUID();
    }

    const env = getRuntimeEnvironmentVariables(
      this.plugin.settings as unknown as Record<string, unknown>,
      this.providerId,
    );
    const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    if (!apiKey) {
      yield {
        type: 'error',
        content: 'Gemini API key is missing. Add GEMINI_API_KEY or GOOGLE_API_KEY in the Gemini provider environment settings.',
      };
      yield { type: 'done' };
      return;
    }

    const model = queryOptions?.model ?? this.resolveModel();
    const providerSettings = getGeminiProviderSettings(this.getProviderSettings());
    const client = new GeminiApiClient({
      apiKey,
      baseUrl: env.GEMINI_API_BASE_URL || env.GOOGLE_GEMINI_BASE_URL,
    });
    const contents = this.buildContents(conversationHistory, turn);
    const systemPrompt = buildSystemPrompt(
      this.getSystemPromptSettings(),
      { appendices: [GEMINI_VAULT_TOOL_APPENDIX] },
    );

    let lastUsageMetadata: GeminiUsageMetadata | undefined;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const modelToolParts: GeminiPart[] = [];
        const functionCalls: GeminiFunctionCall[] = [];

        for await (const delta of client.streamGenerateContent({
          model,
          contents,
          systemInstruction: systemPrompt,
          temperature: providerSettings.temperature,
          tools: GEMINI_VAULT_TOOL_DECLARATIONS,
          signal: this.abortController.signal,
        })) {
          if (this.abortController.signal.aborted) {
            break;
          }

          if (delta.text) {
            yield { type: 'text', content: delta.text };
          }
          if (delta.thought) {
            yield { type: 'thinking', content: delta.thought };
          }
          if (delta.usageMetadata) {
            lastUsageMetadata = delta.usageMetadata;
          }
          if (delta.functionCalls) {
            functionCalls.push(...delta.functionCalls);
            for (const call of delta.functionCalls) {
              modelToolParts.push({
                functionCall: {
                  id: call.id,
                  name: call.name,
                  args: call.args,
                },
              });
            }
          }
        }

        if (this.abortController.signal.aborted) {
          break;
        }

        if (functionCalls.length === 0) {
          break;
        }

        contents.push({ role: 'model', parts: modelToolParts });
        const toolResponseParts: GeminiFunctionResponsePart[] = [];

        for (const call of functionCalls) {
          const id = call.id || `gemini-tool-${randomUUID()}`;
          yield {
            type: 'tool_use',
            id,
            name: call.name,
            input: call.args,
          };

          const approvalResult = await this.ensureToolApproved(call);
          const result = approvalResult ?? await executeGeminiVaultTool(this.plugin, call.name, call.args);
          yield {
            type: 'tool_result',
            id,
            content: result.content,
            isError: result.isError,
          };

          toolResponseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: {
                result: result.content,
                ...(result.isError ? { error: true } : {}),
              },
            },
          });
        }

        contents.push({ role: 'user', parts: toolResponseParts });
      }

      if (lastUsageMetadata) {
        yield {
          type: 'usage',
          usage: this.toUsageInfo(model, lastUsageMetadata),
          sessionId: this.sessionId,
        };
      }

      yield { type: 'done' };
    } catch (error) {
      if (!this.abortController.signal.aborted) {
        yield {
          type: 'error',
          content: error instanceof Error ? error.message : String(error),
        };
      }
      yield { type: 'done' };
    } finally {
      this.abortController = null;
    }
  }

  async steer(_turn: PreparedChatTurn): Promise<boolean> {
    return false;
  }

  cancel(): void {
    this.abortController?.abort();
  }

  resetSession(): void {
    this.sessionId = null;
    this.abortController?.abort();
    this.abortController = null;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  consumeSessionInvalidation(): boolean {
    return false;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands() {
    return [];
  }

  cleanup(): void {
    this.cancel();
    this.setReady(false);
  }

  async rewind(_userMessageId: string, _assistantMessageId: string): Promise<ChatRewindResult> {
    return { canRewind: false, error: 'Gemini API provider does not support rewind yet.' };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }
  setApprovalDismisser(_dismisser: (() => void) | null): void {}
  setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void {}
  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {}
  setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void {}
  setSubagentHookProvider(_getState: () => SubagentRuntimeState): void {}
  setAutoTurnCallback(_callback: ((result: AutoTurnResult) => void) | null): void {}

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = this.turnMetadata;
    this.resetTurnMetadata();
    return metadata;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    return {
      updates: {
        sessionId: params.sessionInvalidated ? null : this.sessionId,
      },
    };
  }

  resolveSessionIdForFork(_conversation: Conversation | null): string | null {
    return null;
  }

  async loadSubagentToolCalls(_agentId: string): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(_agentId: string): Promise<string | null> {
    return null;
  }

  private buildContents(conversationHistory: ChatMessage[], turn: PreparedChatTurn): GeminiContent[] {
    const contents: GeminiContent[] = [];

    for (const message of conversationHistory) {
      if (message.isRebuiltContext || message.isInterrupt) {
        continue;
      }
      const parts = this.buildMessageParts(message.content, message.images);
      if (parts.length === 0) {
        continue;
      }
      contents.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }

    const currentParts = this.buildMessageParts(turn.prompt, turn.request.images);
    if (currentParts.length > 0) {
      contents.push({ role: 'user', parts: currentParts });
    }

    return contents;
  }

  private buildMessageParts(content: string, images?: ChatMessage['images']): GeminiPart[] {
    const parts: GeminiPart[] = [];
    if (content.trim()) {
      parts.push({ text: content });
    }
    for (const image of images ?? []) {
      const imagePart = this.buildImagePart(image);
      if (imagePart) {
        parts.push(imagePart);
      }
    }
    return parts;
  }

  private buildImagePart(image: NonNullable<ChatMessage['images']>[number]): GeminiPart | null {
    const mediaType = image.mediaType === 'image/jpeg' ? 'image/jpeg' : image.mediaType;
    const rawData = typeof image.data === 'string' ? image.data.trim() : '';
    const base64Data = rawData.startsWith('data:') && rawData.includes(',')
      ? rawData.slice(rawData.indexOf(',') + 1)
      : rawData;

    if (!base64Data) {
      return {
        text: `[Image attachment omitted: ${image.name || 'unnamed image'} had no image data.]`,
      };
    }

    if (!GEMINI_SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      return {
        text: `[Image attachment omitted: Gemini currently supports PNG, JPEG, and WebP inputs; ${image.name || 'unnamed image'} was ${image.mediaType}.]`,
      };
    }

    return {
      inlineData: {
        mimeType: mediaType,
        data: base64Data,
      },
    };
  }

  private toUsageInfo(model: string, usage: GeminiUsageMetadata) {
    const inputTokens = usage.promptTokenCount ?? 0;
    const contextWindow = DEFAULT_GEMINI_CONTEXT_WINDOW;
    const contextTokens = inputTokens;
    return {
      model,
      inputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: usage.cachedContentTokenCount ?? 0,
      contextWindow,
      contextWindowIsAuthoritative: false,
      contextTokens,
      percentage: contextWindow > 0 ? Math.min(100, (contextTokens / contextWindow) * 100) : 0,
    };
  }

  private resetTurnMetadata(): void {
    this.turnMetadata = {};
  }

  private setReady(ready: boolean): void {
    this.ready = ready;
    for (const listener of this.readyListeners) {
      listener(ready);
    }
  }

  private getSystemPromptSettings(): SystemPromptSettings {
    const settings = this.plugin.settings;
    return {
      mediaFolder: settings.mediaFolder,
      customPrompt: settings.systemPrompt,
      vaultPath: getVaultPath(this.plugin.app) ?? undefined,
      userName: settings.userName,
    };
  }

  private getProviderSettings(): Record<string, unknown> {
    return ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      this.providerId,
    );
  }

  private resolveModel(): string {
    const providerSettings = this.getProviderSettings();
    return typeof providerSettings.model === 'string' && providerSettings.model
      ? providerSettings.model
      : DEFAULT_GEMINI_PRIMARY_MODEL;
  }

  private async ensureToolApproved(
    call: GeminiFunctionCall,
  ): Promise<{ content: string; isError?: boolean } | null> {
    if (!isGeminiWriteTool(call.name)) {
      return null;
    }

    const settings = this.getProviderSettings();
    if (settings.permissionMode === 'yolo') {
      return null;
    }

    if (!this.approvalCallback) {
      return {
        content: 'Write denied: no approval handler is available.',
        isError: true,
      };
    }

    const description = describeGeminiWriteTool(call.name, call.args);
    const decision = await this.approvalCallback(
      call.name,
      call.args,
      description,
    );

    if (decision === 'allow' || decision === 'allow-always') {
      return null;
    }

    return {
      content: decision === 'cancel'
        ? 'Write cancelled by user.'
        : 'Write denied by user.',
      isError: true,
    };
  }
}
