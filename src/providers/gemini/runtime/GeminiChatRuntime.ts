import { GoogleGenerativeAI, Part, FunctionDeclaration, FunctionCall } from '@google/generative-ai';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport';
import { randomUUID } from 'node:crypto';

import type { McpServerManager } from '../../../core/mcp/McpServerManager';
import { getEnhancedPath } from '../../../utils/env';
import { parseCommand } from '../../../utils/mcp';
import { getMcpServerType } from '../../../core/types';
import type { ProviderCapabilities } from '../../../core/providers/types';
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
} from '../../../core/runtime/types';
import type { ChatMessage, Conversation, SlashCommand, StreamChunk, ToolCallInfo } from '../../../core/types';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type ClaudianPlugin from '../../../main';
import { getGeminiProviderSettings, migrateLegacyGeminiModelId } from '../settings';
import { getGeminiState } from '../types';
import {
  GEMINI_VAULT_TOOLS,
  GEMINI_VAULT_WRITE_TOOLS,
  executeGeminiVaultTool,
  isGeminiVaultTool,
} from './geminiVaultTools';

export interface GeminiRuntimeServices {
  mcpManager: McpServerManager;
}

export class GeminiChatRuntime implements ChatRuntime {
  readonly providerId = 'gemini' as const;

  private plugin: ClaudianPlugin;
  private mcpManager: McpServerManager;
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private turnMetadata: ChatTurnMetadata = {};
  private approvalCallback: ApprovalCallback | null = null;

  constructor(plugin: ClaudianPlugin, services: GeminiRuntimeServices) {
    this.plugin = plugin;
    this.mcpManager = services.mcpManager;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return {
      providerId: 'gemini',
      supportsPersistentRuntime: false,
      supportsNativeHistory: true,
      supportsPlanMode: false,
      supportsRewind: false,
      supportsFork: false,
      supportsProviderCommands: false,
      supportsImageAttachments: true,
      supportsInstructionMode: false,
      supportsMcpTools: true,
      reasoningControl: 'none',
    };
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      isCompact: false,
      mcpMentions: request.enabledMcpServers ?? new Set(),
      persistedContent: '',
      prompt: request.text,
      request,
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    listener(true);
    return () => {};
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {}

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    _externalContextPaths?: string[],
  ): void {
    if (!conversation) {
      this.sessionId = null;
      return;
    }
    const state = getGeminiState(conversation.providerState);
    this.sessionId = state.sessionId ?? conversation.sessionId ?? null;
  }

  async reloadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  async ensureReady(_options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    const settings = getGeminiProviderSettings(this.plugin.settings as unknown as Record<string, unknown>);
    return settings.enabled;
  }

  private buildSystemInstruction(): string {
    const vaultName = this.plugin.app.vault.getName();
    return [
      `You are an AI assistant embedded in the user's Obsidian vault "${vaultName}".`,
      'You have function tools to work with the vault files: list_files, read_file, write_file, edit_file, and search_notes.',
      'When the user asks about their notes or files, or asks you to create or modify content, use these tools instead of saying you cannot access files.',
      'All file paths are vault-relative, e.g. "Folder/Note.md". Markdown is the primary format.',
      'Before editing an existing file, read it first so edits use exact text from the file.',
      'Respond in the language the user writes in.',
    ].join('\n');
  }

  private resolveSelectedModel(queryOptions?: ChatRuntimeQueryOptions): string | null {
    if (typeof queryOptions?.model === 'string' && queryOptions.model) {
      return queryOptions.model;
    }

    const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      this.providerId,
    );
    const model = typeof snapshot.model === 'string' ? snapshot.model : '';
    return model || null;
  }

  private async connectMcpClient(serverConfig: any): Promise<Client | null> {
    const type = getMcpServerType(serverConfig);
    let transport: Transport;
    
    if (type === 'stdio') {
      const { cmd, args } = parseCommand(serverConfig.command, serverConfig.args);
      if (!cmd) return null;
      transport = new StdioClientTransport({
        command: cmd,
        args,
        env: { ...process.env, ...serverConfig.env, PATH: getEnhancedPath(serverConfig.env?.PATH) },
        stderr: 'ignore',
      });
    } else {
      // Basic fallback for SSE/HTTP
      return null; 
    }

    const client = new Client({ name: 'claudian-gemini', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    return client;
  }

  async *query(
    turn: PreparedChatTurn,
    conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    this.abortController = new AbortController();
    this.turnMetadata = {};

    const settings = getGeminiProviderSettings(this.plugin.settings as unknown as Record<string, unknown>);
    const apiKeyMatch = settings.environmentVariables.match(/GEMINI_API_KEY=([^\n]+)/);
    const apiKey = apiKeyMatch ? apiKeyMatch[1].trim() : process.env.GEMINI_API_KEY;

    if (!apiKey) {
      yield { type: 'error', content: 'Gemini API Key is not configured.' };
      yield { type: 'done' };
      return;
    }

    // Built-in vault file tools + MCP servers
    const activeServers = this.mcpManager.getActiveServers(turn.mcpMentions);
    const mcpClients = new Map<string, { client: Client; serverName: string }>();
    const tools: FunctionDeclaration[] = [...GEMINI_VAULT_TOOLS];

    for (const [serverName, config] of Object.entries(activeServers)) {
      try {
        const client = await this.connectMcpClient(config);
        if (client) {
          const list = await client.listTools();
          for (const t of list.tools) {
            const geminiToolName = `mcp__${serverName}__${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
            tools.push({
              name: geminiToolName,
              description: t.description || 'MCP Tool',
              parameters: t.inputSchema as any,
            });
            mcpClients.set(geminiToolName, { client, serverName: t.name });
          }
        }
      } catch (e) {
        yield { type: 'notice', content: `Failed to connect to MCP server ${serverName}`, level: 'warning' };
      }
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const modelId = migrateLegacyGeminiModelId(
      this.resolveSelectedModel(queryOptions) || settings.visibleModels[0] || 'gemini-2.5-flash',
    );
    
    const history = (conversationHistory || []).map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    }));

    const model = genAI.getGenerativeModel({
      model: modelId,
      systemInstruction: this.buildSystemInstruction(),
      tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined
    });
    
    const chat = model.startChat({ history });

    let parts: Part[] = [];
    if (turn.request.text) {
      parts.push({ text: turn.request.text });
    }

    if (turn.request.images && turn.request.images.length > 0) {
      for (const img of turn.request.images) {
        const base64Data = img.data.replace(/^data:image\/\w+;base64,/, '');
        parts.push({
          inlineData: { data: base64Data, mimeType: img.mediaType }
        });
      }
    }

    try {
      yield { type: 'user_message_start', content: turn.request.text };

      let continueLoop = true;
      while (continueLoop) {
        if (this.abortController.signal.aborted) break;

        yield { type: 'assistant_message_start' };
        const result = await chat.sendMessageStream(parts);
        
        let functionCalls: FunctionCall[] = [];
        
        for await (const chunk of result.stream) {
          if (this.abortController.signal.aborted) break;
          
          const chunkFunctionCalls = chunk.functionCalls();
          if (chunkFunctionCalls && chunkFunctionCalls.length > 0) {
            functionCalls.push(...chunkFunctionCalls);
          }
          
          const text = chunk.text();
          if (text) {
            yield { type: 'text', content: text };
          }
        }

        if (functionCalls.length > 0) {
          parts = []; // Reset parts for next turn
          for (const call of functionCalls) {
            const toolId = randomUUID();
            yield { type: 'tool_use', id: toolId, name: call.name, input: call.args as Record<string, unknown> };

            const mcpInfo = mcpClients.get(call.name);
            let toolResultContent = '';
            let isError = false;

            if (isGeminiVaultTool(call.name)) {
              const needsApproval = GEMINI_VAULT_WRITE_TOOLS.has(call.name);
              const approved = needsApproval && this.approvalCallback
                ? await this.approvalCallback(call.name, call.args as Record<string, unknown>, `Call ${call.name}`)
                : 'allow';

              if (approved === 'allow' || approved === 'allow-always') {
                const result = await executeGeminiVaultTool(
                  this.plugin,
                  call.name,
                  (call.args ?? {}) as Record<string, unknown>,
                );
                toolResultContent = result.content;
                isError = result.isError;
              } else {
                toolResultContent = 'User denied permission to use this tool.';
                isError = true;
              }
            } else if (mcpInfo) {
              const approved = this.approvalCallback 
                ? await this.approvalCallback(call.name, call.args as Record<string, unknown>, `Call ${call.name}`)
                : 'allow';
                
              if (approved === 'allow' || approved === 'allow-always') {
                try {
                  const mcpResult = await mcpInfo.client.callTool({
                    name: mcpInfo.serverName,
                    arguments: call.args as Record<string, unknown>
                  });
                  const resultContent = mcpResult.content as { text?: string }[] | undefined;
                  toolResultContent = (resultContent ?? []).map((c) => c.text ?? '').join('\n');
                  isError = !!mcpResult.isError;
                } catch (err) {
                  toolResultContent = String(err);
                  isError = true;
                }
              } else {
                toolResultContent = 'User denied permission to use this tool.';
                isError = true;
              }
            } else {
              toolResultContent = 'Tool not found.';
              isError = true;
            }

            yield { type: 'tool_result', id: toolId, content: toolResultContent, isError };
            parts.push({
              functionResponse: {
                name: call.name,
                response: { result: toolResultContent }
              }
            });
          }
        } else {
          continueLoop = false;
        }
      }

      this.turnMetadata.wasSent = true;
    } catch (error) {
      yield { type: 'error', content: error instanceof Error ? error.message : String(error) };
    } finally {
      this.abortController = null;
      for (const info of mcpClients.values()) {
        info.client.close().catch(() => {});
      }
    }

    yield { type: 'done' };
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  resetSession(): void {
    this.sessionId = null;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  consumeSessionInvalidation(): boolean {
    return false;
  }

  isReady(): boolean {
    return true;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  getAuxiliaryModel(): string | null {
    return null;
  }

  cleanup(): void {
    this.cancel();
  }

  async rewind(_u: string, _a: string | undefined, _m?: ChatRewindMode): Promise<ChatRewindResult> {
    return { canRewind: false };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }
  setApprovalDismisser(_dismisser: (() => void) | null): void {}
  setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void {}
  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {}
  setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void {}
  setSubagentHookProvider(_getState: () => any): void {}
  setAutoTurnCallback(_callback: AutoTurnCallback | null): void {}

  consumeTurnMetadata(): ChatTurnMetadata {
    const meta = { ...this.turnMetadata };
    this.turnMetadata = {};
    return meta;
  }

  buildSessionUpdates({ sessionInvalidated }: { conversation: Conversation | null; sessionInvalidated: boolean; }): SessionUpdateResult {
    if (sessionInvalidated) {
      return { updates: { sessionId: null, providerState: undefined } };
    }
    return { updates: { sessionId: this.sessionId } };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    return this.sessionId ?? conversation?.sessionId ?? null;
  }
}
