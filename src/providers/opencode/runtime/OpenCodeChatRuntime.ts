/**
 * OpenCode ACP (Agent Client Protocol) Runtime for Claudian
 * 
 * Communicates with OpenCode via stdio JSON-RPC 2.0 using the ACP protocol.
 * Similar to Codex's approach but adapted for OpenCode's ACP implementation.
 */

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';

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
import type {
  ChatMessage,
  Conversation,
  SlashCommand,
  StreamChunk,
} from '../../../core/types';
import type { ProviderId } from '../../../core/types/provider';
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';
import { OPENCODE_PROVIDER_CAPABILITIES } from '../capabilities';
import { OpenCodeCliResolver } from './OpenCodeCliResolver';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface OpenCodeSession {
  id: string;
  cwd: string;
  mcpServers: Array<{ name: string; config: Record<string, unknown> }>;
  models: {
    currentModelId: string;
    availableModels: Array<{ modelId: string; name: string }>;
  };
  modes: {
    currentModeId: string;
    availableModes: Array<{ id: string; name: string; description?: string }>;
  };
}

interface TurnState {
  chunks: StreamChunk[];
  complete: boolean;
  error?: string;
}

export class OpenCodeChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'opencode';
  
  private process: ChildProcess | null = null;
  private messageId = 0;
  private pendingRequests = new Map<number | string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private buffer = '';
  private readyState = false;
  private session: OpenCodeSession | null = null;
  private cliResolver = new OpenCodeCliResolver();
  private approvalCallback: ApprovalCallback | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private currentTurnAbort: AbortController | null = null;
  private onReadyChangeListeners: Array<(ready: boolean) => void> = [];
  private sessionInvalidated = false;
  private currentTurn: TurnState | null = null;

  constructor(private plugin: ClaudianPlugin) {}

  getCapabilities() {
    return OPENCODE_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      request,
      persistedContent: request.text,
      prompt: request.text,
      isCompact: false,
      mcpMentions: new Set(),
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.onReadyChangeListeners.push(listener);
    return () => {
      const index = this.onReadyChangeListeners.indexOf(listener);
      if (index !== -1) this.onReadyChangeListeners.splice(index, 1);
    };
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {
    // OpenCode handles resume through session/load
  }

  syncConversationState(
    _conversation: ChatRuntimeConversationState | null,
    _externalContextPaths?: string[]
  ): void {
    // Sync state when needed
  }

  async reloadMcpServers(): Promise<void> {
    // OpenCode manages MCP servers per-session
  }

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    if (this.readyState && this.process && !this.process.killed) {
      return true;
    }

    await this.startProcess(options?.externalContextPaths);
    return this.readyState;
  }

  private async startProcess(_externalContextPaths?: string[]): Promise<void> {
    const cliPath = this.cliResolver.resolveFromSettings(
      this.plugin.settings as unknown as Record<string, unknown>
    );

    if (!cliPath) {
      throw new Error('OpenCode CLI not found. Please install it or configure the path in settings.');
    }

    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      throw new Error('Could not determine vault path.');
    }

    console.log(`Starting OpenCode: ${cliPath} acp --cwd ${vaultPath}`);

    this.process = spawn(cliPath, ['acp', '--cwd', vaultPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      shell: process.platform === 'win32',
    });

    this.setupProcessHandlers();
    await this.initializeProtocol();
  }

  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.on('error', (error) => {
      console.error('OpenCode process error:', error);
      this.readyState = false;
      this.notifyReadyChange(false);
    });

    this.process.on('exit', (code, signal) => {
      console.log(`OpenCode process exited with code ${code}, signal ${signal}`);
      this.readyState = false;
      this.notifyReadyChange(false);
    });

    if (this.process.stdout) {
      this.process.stdout.on('data', (chunk: Buffer) => {
        this.handleOutput(chunk.toString());
      });
    }

    if (this.process.stderr) {
      this.process.stderr.on('data', (chunk: Buffer) => {
        console.error('OpenCode stderr:', chunk.toString());
      });
    }
  }

  private async initializeProtocol(): Promise<void> {
    const result = await this.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        _meta: {
          'terminal-auth': true,
        },
      },
    });

    if (result && typeof result === 'object' && 'protocolVersion' in result) {
      this.readyState = true;
      this.notifyReadyChange(true);
    } else {
      throw new Error('Failed to initialize OpenCode ACP protocol');
    }
  }

  async *query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    _queryOptions?: ChatRuntimeQueryOptions
  ): AsyncGenerator<StreamChunk> {
    console.log('OpenCode query started');
    // Ensure the runtime is ready (starts process if needed)
    if (!this.readyState) {
      console.log('OpenCode ensuring ready...');
      await this.ensureReady();
    }

    // Ensure we have a session
    if (!this.session) {
      console.log('OpenCode ensuring session...');
      await this.ensureSession(turn);
    }

    if (!this.session) {
      throw new Error('Session not initialized');
    }

    this.currentTurnAbort = new AbortController();
    this.currentTurn = { chunks: [], complete: false };

    try {
      // Build prompt as an array of content blocks (ACP protocol requirement)
      const promptBlocks: any[] = [
        { type: 'text', text: turn.request.text }
      ];

      // Add images if present
      if (turn.request.images && turn.request.images.length > 0) {
        for (const img of turn.request.images) {
          promptBlocks.push({
            type: 'image',
            data: (img as any).data,
            mimeType: (img as any).mimeType,
          });
        }
      }

      // Send the prompt (returns when the turn is complete)
      console.log(`OpenCode sending prompt, id=${this.messageId + 1}`);
      const requestPromise = this.sendRequest('session/prompt', {
        sessionId: this.session.id,
        prompt: promptBlocks,
      }, 300000); // 5 minute timeout

      // Poll for chunks while waiting for the request to resolve
      // The request promise resolves when the final JSON-RPC response arrives
      let loops = 0;
      while (true) {
        loops++;
        if (loops % 20 === 0) console.log(`OpenCode query loop ${loops}, chunks=${this.currentTurn.chunks.length}`);
        
        if (this.currentTurnAbort.signal.aborted) {
          console.log('OpenCode query aborted');
          break;
        }

        if (this.currentTurn.chunks.length > 0) {
          yield this.currentTurn.chunks.shift()!;
        }

        // Check if request is done by racing with a short timeout
        const done = await Promise.race([
          requestPromise.then(() => true).catch(() => true),
          new Promise(resolve => setTimeout(() => resolve(false), 50)),
        ]);

        if (done && this.currentTurn.chunks.length === 0) {
          console.log('OpenCode query finished');
          break;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message !== 'Turn aborted') {
        yield { type: 'error', content: error.message };
      }
    } finally {
      yield { type: 'done' };
      this.currentTurn = null;
    }
  }

  private async ensureSession(_turn: PreparedChatTurn): Promise<void> {
    if (!this.session) {
      const vaultPath = getVaultPath(this.plugin.app);
      if (!vaultPath) {
        throw new Error('Could not determine vault path');
      }

      const result = await this.sendRequest('session/new', {
        cwd: vaultPath,
        mcpServers: [],
      });

      if (result && typeof result === 'object' && 'sessionId' in result) {
        this.session = {
          id: (result as any).sessionId,
          cwd: vaultPath,
          mcpServers: [],
          models: { currentModelId: '', availableModels: [] },
          modes: { currentModeId: '', availableModes: [] },
        };
      } else {
        throw new Error('Failed to create OpenCode session');
      }
    }
  }

  async cancel(): Promise<void> {
    if (this.currentTurnAbort) {
      this.currentTurnAbort.abort();
    }
    
    if (this.session) {
      await this.sendRequest('session/cancel', {
        sessionId: this.session.id,
      }).catch(() => {});
    }
  }

  resetSession(): void {
    this.session = null;
    this.sessionInvalidated = true;
  }

  getSessionId(): string | null {
    return this.session?.id || null;
  }

  consumeSessionInvalidation(): boolean {
    const wasInvalidated = this.sessionInvalidated;
    this.sessionInvalidated = false;
    return wasInvalidated;
  }

  isReady(): boolean {
    return this.readyState;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    // OpenCode doesn't expose slash commands through ACP yet
    return [];
  }

  cleanup(): void {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.pendingRequests.forEach(({ timeout }) => clearTimeout(timeout));
    this.pendingRequests.clear();
    this.readyState = false;
    this.session = null;
  }

  async rewind(_userMessageId: string, _assistantMessageId: string): Promise<ChatRewindResult> {
    // OpenCode rewind not yet implemented through ACP
    throw new Error('Rewind not supported for OpenCode provider');
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(_dismisser: (() => void) | null): void {
    // Not implemented for OpenCode
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserQuestionCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void {
    // Not implemented for OpenCode
  }

  setSubagentHookProvider(_getState: () => SubagentRuntimeState): void {
    // Not implemented for OpenCode
  }

  setAutoTurnCallback(_callback: ((result: AutoTurnResult) => void) | null): void {
    // Not implemented for OpenCode
  }

  consumeTurnMetadata(): ChatTurnMetadata {
    return {};
  }

  buildSessionUpdates(_params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    return {
      updates: {},
    };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    return conversation?.sessionId || null;
  }

  private handleOutput(data: string): void {
    this.buffer += data;

    // Process complete JSON lines
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);
        this.handleMessage(message);
      } catch (error) {
        console.error('Failed to parse OpenCode message:', error);
      }
    }
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    if ('id' in message && message.id !== undefined) {
      // This is a response
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        if ('error' in message && message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
        this.pendingRequests.delete(message.id);
      }
    } else if ('method' in message) {
      // This is a notification (streaming update)
      this.handleNotification(message as JsonRpcNotification);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (!this.currentTurn) return;

    switch (notification.method) {
      case 'session/update': {
        const params = notification.params as any;
        const update = params?.update;
        if (!update) return;

        switch (update.sessionUpdate) {
          case 'agent_message_chunk': {
            const text = update.content?.text;
            if (text) {
              this.currentTurn.chunks.push({ type: 'text', content: text });
            }
            break;
          }
          case 'agent_thought_chunk': {
            const text = update.content?.text;
            if (text) {
              this.currentTurn.chunks.push({ type: 'thinking', content: text });
            }
            break;
          }
          case 'tool_call_update': {
            // Could handle tool calls here
            break;
          }
          case 'usage_update': {
            // Could handle usage updates here
            break;
          }
        }
        break;
      }
      case 'session/completed': {
        if (this.currentTurn) {
          this.currentTurn.complete = true;
        }
        break;
      }
      case 'session/error': {
        if (this.currentTurn) {
          this.currentTurn.error = (notification.params as any)?.message || 'Unknown error';
          this.currentTurn.complete = true;
        }
        break;
      }
    }
  }

  private sendRequest(method: string, params: Record<string, unknown>, timeout = 30000): Promise<unknown> {
    const id = ++this.messageId;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        reject(new Error('OpenCode process not started'));
        return;
      }

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timeout: timer });

      try {
        this.process.stdin.write(JSON.stringify(request) + '\n');
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private notifyReadyChange(ready: boolean): void {
    for (const listener of this.onReadyChangeListeners) {
      listener(ready);
    }
  }
}
