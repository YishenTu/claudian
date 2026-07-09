 
import type {
  ProviderCapabilities,
  ProviderId,
} from '../../../core/providers/types';
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
import {
  type ApprovalDecision,
  type ChatMessage,
  type Conversation,
  type ImageAttachment,
  type SlashCommand,
  type StreamChunk,
  type ToolCallInfo,
  type UsageInfo,
} from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { appendContextFiles, appendCurrentNote } from '../../../utils/context';
import { getVaultPath } from '../../../utils/path';
import { OCTO_AGENT_PROVIDER_CAPABILITIES } from '../capabilities';
import { getOctoAgentProviderSettings } from '../settings';
import { getOctoAgentState } from '../types';
import { OctoAgentClient, type OctoAgentEvent, type OctoAgentMessage, type OctoAgentUserFile } from './OctoAgentClient';
import { ensureOctoAgentServerRunning } from './OctoAgentServerLauncher';

interface PendingQuestion {
  resolve: (answer: { choices: string[]; custom: string; cancelled: boolean }) => void;
}

interface PendingConfirmation {
  resolve: (result: string) => void;
}

interface ActiveQuery {
  done: boolean;
  turnAborted: boolean;
}

export class OctoAgentChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'octo-agent';

  private plugin: ClaudianPlugin;
  private client: OctoAgentClient | null = null;
  private ready = false;
  private readyListeners = new Set<(ready: boolean) => void>();
  private sessionId: string | null = null;
  private sessionInvalidated = false;
  private activeQuery: ActiveQuery | null = null;
  private currentTurnMetadata: ChatTurnMetadata = {};
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private autoTurnCallback: AutoTurnCallback | null = null;
  private subagentHookProvider: (() => SubagentRuntimeState) | null = null;
  private toolIndex = 0;
  private currentToolId: string | null = null;
  private supportedCommands: SlashCommand[] = [];
  private serverStartPromise: Promise<boolean> | null = null;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return OCTO_AGENT_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    const text = request.text;
    const images = request.images ?? [];

    let prompt = text;
    if (request.currentNotePath) {
      prompt = appendCurrentNote(prompt, request.currentNotePath);
    }

    const externalContextPaths = request.externalContextPaths?.filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    if (externalContextPaths && externalContextPaths.length > 0) {
      prompt = appendContextFiles(prompt, externalContextPaths);
    }

    if (images.length > 0) {
      const imageParts = (images as ImageAttachment[]).map(
        (image, index) => `[Attached image ${index + 1}: ${image.name}]`,
      );
      prompt = `${prompt}\n\n${imageParts.join('\n')}`;
    }

    return {
      isCompact: false,
      mcpMentions: new Set(),
      persistedContent: text,
      prompt,
      request,
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    listener(this.ready);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {
    // octo-agent does not support resuming from a named checkpoint through this API.
  }

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    _externalContextPaths?: string[],
  ): void {
    if (!conversation) {
      this.sessionId = null;
      return;
    }
    const state = getOctoAgentState(conversation.providerState);
    this.sessionId = conversation.sessionId ?? state.sessionId ?? null;
  }

  async reloadMcpServers(): Promise<void> {
    // octo-agent manages its own MCP servers; no action required.
  }

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    if (this.ready && this.client?.isConnected()) {
      return true;
    }

    const settings = getOctoAgentProviderSettings(
      this.plugin.settings as unknown as Record<string, unknown>,
    );
    if (!settings.enabled) {
      return false;
    }

    // Auto-start octo serve if configured and not already running.
    if (settings.autoStartServer && !this.serverStartPromise) {
      this.serverStartPromise = ensureOctoAgentServerRunning({ plugin: this.plugin }).finally(() => {
        this.serverStartPromise = null;
      });
    }
    if (this.serverStartPromise) {
      const started = await this.serverStartPromise;
      if (!started) {
        return false;
      }
    }

    if (!this.client) {
      this.client = new OctoAgentClient({
        accessKey: settings.accessKey || undefined,
        baseUrl: this.getBaseUrl(),
      });
    }

    if (!this.client.isConnected()) {
      const connected = await this.connectClient();
      if (!connected) {
        return false;
      }
    }

    if (options?.force || !this.sessionId) {
      await this.createSessionIfNeeded(options?.allowSessionCreation !== false);
    }

    if (this.sessionId) {
      this.client.subscribe(this.sessionId);
      await this.applySettingsToSession(this.sessionId);
    }

    this.setReady(true);
    return true;
  }

  async *query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    _queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    if (this.activeQuery) {
      yield { type: 'error', content: 'A query is already in progress.' };
      return;
    }

    const ready = await this.ensureReady();
    if (!ready || !this.client || !this.sessionId) {
      yield { type: 'error', content: 'Octo Agent is not ready or not connected.' };
      return;
    }

    this.activeQuery = { done: false, turnAborted: false };
    this.currentTurnMetadata = {};
    this.toolIndex = 0;
    this.currentToolId = null;

    const eventBuffer = new OctoAgentEventBuffer();
    const handler = (event: OctoAgentEvent): void => {
      eventBuffer.push(event);
    };
    const onEvent = (event: OctoAgentEvent): void => handler(event);
    this.client.onEvent = onEvent;

    try {
      this.client.sendMessage(
        this.sessionId,
        turn.prompt,
        this.buildImageFiles(turn.request.images),
      );

      while (!this.activeQuery.done && !this.activeQuery.turnAborted) {
        while (true) {
          const event = eventBuffer.shift();
          if (!event) break;
          for (const chunk of this.handleEvent(event)) {
            yield chunk;
          }
        }
        await eventBuffer.wait(50);
      }

      if (this.activeQuery.turnAborted) {
        yield { type: 'error', content: 'Turn was interrupted.' };
      }
    } finally {
      this.activeQuery = null;
      this.currentTurnMetadata = {};
      this.client.onEvent = undefined;
    }

    yield { type: 'done' };
  }

  cancel(): void {
    if (this.activeQuery && this.client && this.sessionId) {
      this.activeQuery.turnAborted = true;
      this.client.interrupt(this.sessionId);
    }
  }

  resetSession(): void {
    if (this.client && this.sessionId) {
      this.client.unsubscribe(this.sessionId);
    }
    this.sessionId = null;
    this.sessionInvalidated = false;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  consumeSessionInvalidation(): boolean {
    const invalidated = this.sessionInvalidated;
    this.sessionInvalidated = false;
    return invalidated;
  }

  isReady(): boolean {
    return this.ready && this.client?.isConnected() === true;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return this.supportedCommands;
  }

  getAuxiliaryModel(): string | null {
    return null;
  }

  cleanup(): void {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.setReady(false);
    this.pendingConfirmations.clear();
    this.pendingQuestions.clear();
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string | undefined,
    _mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    return { canRewind: false, error: 'Rewind is not supported by Octo Agent.' };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserQuestionCallback = callback;
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

  setAutoTurnCallback(callback: AutoTurnCallback | null): void {
    this.autoTurnCallback = callback;
  }

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = this.currentTurnMetadata;
    this.currentTurnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const updates: Partial<Conversation> = {};
    if (params.sessionInvalidated) {
      updates.sessionId = null;
      updates.providerState = undefined;
    } else if (this.sessionId && params.conversation?.sessionId !== this.sessionId) {
      updates.sessionId = this.sessionId;
      updates.providerState = { sessionId: this.sessionId };
    }
    return { updates };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    return conversation?.sessionId ?? null;
  }

  async loadSubagentToolCalls(): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(): Promise<string | null> {
    return null;
  }

  async loadHistory(): Promise<ChatMessage[]> {
    console.log('[octo-agent] loadHistory called for session:', this.sessionId);
    if (!this.sessionId) {
      return [];
    }

    try {
      const ready = await this.ensureReady({ allowSessionCreation: false });
      if (!ready || !this.client) {
        return [];
      }
      const messages = await this.client.getSessionMessages(this.sessionId);
      return this.convertServerMessages(messages);
    } catch (error) {
      console.error('Failed to load octo-agent history:', error);
      return [];
    }
  }

  private convertServerMessages(messages: OctoAgentMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];
    let timestamp = Date.now();

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : null;
      if (!role) {
        continue;
      }

      const content = typeof message.content === 'string' ? message.content : '';
      if (!content && (!message.blocks || message.blocks.length === 0)) {
        continue;
      }

      timestamp += 1;
      result.push({
        id: `octo-hist-${i}`,
        role,
        content,
        timestamp,
      });
    }

    return result;
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) {
      return;
    }
    this.ready = ready;
    for (const listener of this.readyListeners) {
      try {
        listener(ready);
      } catch (error) {
        console.error('Error in OctoAgent ready listener:', error);
      }
    }
  }

  private getBaseUrl(): string {
    const settings = getOctoAgentProviderSettings(
      this.plugin.settings as unknown as Record<string, unknown>,
    );
    return `http://${settings.host}:${settings.port}`;
  }

  private connectClient(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.client) {
        resolve(false);
        return;
      }

      let settled = false;
      const timeout = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, 5000);

      this.client.connect({
        onClose: () => {
          this.setReady(false);
        },
        onError: (error) => {
          console.error('OctoAgent WebSocket error:', error);
          if (!settled) {
            settled = true;
            window.clearTimeout(timeout);
            resolve(false);
          }
        },
        onEvent: (event) => {
          this.handleClientEvent(event);
        },
        onOpen: () => {
          if (!settled) {
            settled = true;
            window.clearTimeout(timeout);
            resolve(true);
          }
        },
      });
    });
  }

  private async createSessionIfNeeded(allowCreation: boolean): Promise<void> {
    if (this.sessionId) {
      return;
    }
    if (!allowCreation) {
      return;
    }
    if (!this.client) {
      return;
    }

    const session = await this.client.createSession({
      name: 'Claudian',
      source: 'claudian',
    });
    this.sessionId = session.id;
  }

  private async applySettingsToSession(sessionId: string): Promise<void> {
    if (!this.client) {
      return;
    }

    const vaultPath = getVaultPath(this.plugin.app);
    if (vaultPath) {
      try {
        await this.client.setWorkingDir(sessionId, vaultPath);
      } catch (error) {
        console.error('Failed to set octo-agent working directory:', error);
      }
    }

    const settings = getOctoAgentProviderSettings(
      this.plugin.settings as unknown as Record<string, unknown>,
    );
    if (this.plugin.settings.model) {
      try {
        const modelId = String(this.plugin.settings.model).replace(/^octo-agent\//, '');
        if (modelId && modelId !== 'octo-agent') {
          await this.client.setModel(sessionId, modelId);
        }
      } catch (error) {
        console.error('Failed to set octo-agent model:', error);
      }
    }

    const permissionMode = typeof settings.environmentVariables === 'string'
      && settings.environmentVariables.includes('OCTO_PERMISSION_MODE=auto')
      ? 'auto'
      : 'interactive';
    try {
      await this.client.setPermissionMode(sessionId, permissionMode);
    } catch (error) {
      console.error('Failed to set octo-agent permission mode:', error);
    }
  }

  private buildImageFiles(images: ImageAttachment[] | undefined): OctoAgentUserFile[] | undefined {
    if (!images || images.length === 0) {
      return undefined;
    }
    return images.map((image) => ({
      dataUrl: `data:${image.mediaType};base64,${image.data}`,
      mimeType: image.mediaType,
      name: image.name,
    }));
  }

  private handleClientEvent(event: OctoAgentEvent): void {
    if (this.activeQuery) {
      // Handled by the active query loop through the event buffer.
      return;
    }

    // Handle out-of-band events such as confirmations or questions that may arrive
    // while no active query is running (e.g. after reconnect or background task).
    if (event.type === 'request_confirmation') {
      void this.handleConfirmation(event);
    } else if (event.type === 'request_user_question') {
      void this.handleUserQuestion(event);
    }
  }

  private *handleEvent(event: OctoAgentEvent): Generator<StreamChunk> {
    switch (event.type) {
      case 'text_delta': {
        yield { type: 'text', content: event.text };
        break;
      }
      case 'thinking_delta': {
        yield { type: 'thinking', content: event.text };
        break;
      }
      case 'assistant_message': {
        // The assistant_message event carries the final full response. If we already
        // streamed deltas, we avoid duplicating content here. Deltas are preferred.
        // In a future iteration we can compare and emit a final text chunk if needed.
        break;
      }
      case 'output': {
        yield { type: 'text', content: event.content };
        break;
      }
      case 'tool_call': {
        this.toolIndex += 1;
        this.currentToolId = `tool-${this.toolIndex}`;
        yield {
          type: 'tool_use',
          id: this.currentToolId,
          name: event.name,
          input: typeof event.args === 'object' && event.args !== null
            ? (event.args as Record<string, unknown>)
            : { arg: event.args },
        };
        break;
      }
      case 'tool_result': {
        const toolId = this.currentToolId ?? 'tool-0';
        yield {
          type: 'tool_result',
          id: toolId,
          content: event.result,
          isError: false,
          toolUseResult: event.ui_payload,
        };
        this.currentToolId = null;
        break;
      }
      case 'tool_error': {
        const toolId = event.tool_id ?? this.currentToolId ?? 'tool-0';
        yield {
          type: 'tool_result',
          id: toolId,
          content: event.error,
          isError: true,
        };
        this.currentToolId = null;
        break;
      }
      case 'tool_stdout': {
        const toolId = event.tool_id ?? this.currentToolId ?? 'tool-0';
        for (const line of event.lines) {
          yield { type: 'tool_output', id: toolId, content: line };
        }
        break;
      }
      case 'complete': {
        if (this.activeQuery) {
          this.activeQuery.done = true;
        }
        break;
      }
      case 'interrupted': {
        if (this.activeQuery) {
          this.activeQuery.turnAborted = true;
        }
        break;
      }
      case 'session_update': {
        const usage = this.buildUsageInfo(event);
        if (usage) {
          yield { type: 'usage', usage, sessionId: event.session_id };
        }
        break;
      }
      case 'request_confirmation': {
        void this.handleConfirmation(event);
        break;
      }
      case 'request_user_question': {
        void this.handleUserQuestion(event);
        break;
      }
      case 'error': {
        yield { type: 'error', content: event.message };
        break;
      }
      case 'toast': {
        yield { type: 'notice', content: event.message, level: 'info' };
        break;
      }
      default: {
        // Unknown events are ignored.
        break;
      }
    }
  }

  private async handleConfirmation(
    event: Extract<OctoAgentEvent, { type: 'request_confirmation' }>,
  ): Promise<void> {
    if (!this.client) {
      return;
    }

    const callback = this.approvalCallback;
    if (!callback) {
      this.client.confirm(event.id, 'no');
      return;
    }

    try {
      const decision = await callback(
        event.tool_name || 'octo-agent',
        {
          command: event.command,
          diff: event.diff,
          input: event.input,
          kind: event.kind,
        },
        event.message,
        {
          decisionOptions: this.buildDecisionOptions(event.kind),
        },
      );
      this.client.confirm(event.id, this.mapApprovalDecision(decision, event.kind));
    } catch (error) {
      console.error('Error handling octo-agent confirmation:', error);
      this.client.confirm(event.id, 'no');
    }
  }

  private buildDecisionOptions(
    kind: string,
  ): Array<{ label: string; value: string; description?: string }> | undefined {
    if (kind === 'ok') {
      return [{ label: 'OK', value: 'allow' }];
    }
    if (kind === 'yes_no_always') {
      return [
        { label: 'Yes', value: 'allow' },
        { label: 'Always', value: 'allow-always' },
        { label: 'No', value: 'deny' },
      ];
    }
    return [
      { label: 'Yes', value: 'allow' },
      { label: 'No', value: 'deny' },
    ];
  }

  private mapApprovalDecision(
    decision: ApprovalDecision,
    kind: string,
  ): string {
    if (decision === 'cancel' || decision === 'deny') {
      return 'no';
    }
    if (decision === 'allow-always') {
      return kind === 'yes_no' ? 'yes' : 'always';
    }
    if (decision === 'allow') {
      return 'yes';
    }
    if (typeof decision === 'object' && decision.type === 'select-option') {
      return decision.value;
    }
    return 'no';
  }

  private async handleUserQuestion(
    event: Extract<OctoAgentEvent, { type: 'request_user_question' }>,
  ): Promise<void> {
    if (!this.client) {
      return;
    }

    const callback = this.askUserQuestionCallback;
    if (!callback) {
      this.client.answerUserQuestion(event.question_id, [], '', true);
      return;
    }

    try {
      const result = await callback({
        header: event.header,
        questions: [
          {
            header: event.header || event.question,
            id: event.question_id,
            isOther: true,
            multiSelect: event.multi_select,
            options: event.options.map((option) => ({ description: '', label: option })),
            question: event.question,
          },
        ],
      });

      if (result === null) {
        this.client.answerUserQuestion(event.question_id, [], '', true);
        return;
      }

      const answer = result[event.question_id] ?? result[event.question];
      const { choices, custom } = this.normalizeAnswer(answer, event.options);
      this.client.answerUserQuestion(event.question_id, choices, custom, false);
    } catch (error) {
      console.error('Error handling octo-agent user question:', error);
      this.client.answerUserQuestion(event.question_id, [], '', true);
    }
  }

  private normalizeAnswer(
    answer: string | string[] | undefined,
    options: string[],
  ): { choices: string[]; custom: string } {
    if (answer === undefined || answer === null) {
      return { choices: [], custom: '' };
    }

    const values = Array.isArray(answer) ? answer : [answer];
    const choices: string[] = [];
    const custom: string[] = [];

    for (const value of values) {
      if (options.includes(value)) {
        choices.push(value);
      } else if (value.trim()) {
        custom.push(value);
      }
    }

    return { choices, custom: custom.join(', ') };
  }

  private buildUsageInfo(
    event: Extract<OctoAgentEvent, { type: 'session_update' }>,
  ): UsageInfo | null {
    if (typeof event.context_usage !== 'number') {
      return null;
    }

    const contextWindow = 200_000;
    const contextTokens = event.context_usage;
    return {
      contextTokens,
      contextWindow,
      inputTokens: contextTokens,
      percentage: Math.min(100, Math.round((contextTokens / contextWindow) * 1000) / 10),
    };
  }
}

class OctoAgentEventBuffer {
  private events: OctoAgentEvent[] = [];
  private resolvers: Array<() => void> = [];

  push(event: OctoAgentEvent): void {
    this.events.push(event);
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve();
    }
  }

  shift(): OctoAgentEvent | undefined {
    return this.events.shift();
  }

  async wait(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        this.resolvers = this.resolvers.filter((r) => r !== resolver);
        resolve();
      }, timeoutMs);
      const resolver = () => {
        window.clearTimeout(timer);
        this.resolvers = this.resolvers.filter((r) => r !== resolver);
        resolve();
      };
      this.resolvers.push(resolver);
    });
  }
}
