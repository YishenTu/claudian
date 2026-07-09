 
export interface OctoAgentClientOptions {
  baseUrl: string;
  accessKey?: string;
}

export interface OctoAgentSession {
  id: string;
  name: string;
  status?: string;
  workingDir?: string;
  permissionMode?: string;
  reasoningEffort?: string;
  showReasoning?: boolean;
  contextUsage?: number;
}

export interface OctoAgentMessage {
  type?: string;
  role?: string;
  content?: string;
  created_at?: number;
  blocks?: unknown[];
}

export interface OctoAgentUserFile {
  name: string;
  dataUrl?: string;
  path?: string;
  mimeType?: string;
}

export type OctoAgentEvent =
  | { type: 'text_delta'; session_id: string; text: string }
  | { type: 'thinking_delta'; session_id: string; text: string }
  | { type: 'assistant_message'; session_id: string; content: string; thinking?: string }
  | { type: 'tool_call'; session_id: string; name: string; args: any; summary?: string }
  | { type: 'tool_result'; session_id: string; result: string; tool_id?: string; ui_payload?: any }
  | { type: 'tool_error'; session_id: string; error: string; tool_id?: string }
  | { type: 'tool_stdout'; session_id: string; lines: string[]; tool_id?: string }
  | { type: 'output'; session_id: string; content: string }
  | { type: 'progress'; session_id: string; phase: string; message?: string; progress_type?: string }
  | { type: 'complete'; session_id: string; iterations: number; awaiting_user_feedback?: boolean }
  | { type: 'error'; session_id: string; message: string }
  | { type: 'session_update'; session_id: string; context_usage?: number; status?: string; working_dir?: string; permission_mode?: string; reasoning_effort?: string; show_reasoning?: boolean }
  | { type: 'request_confirmation'; session_id: string; id: string; message: string; kind: string; tool_name?: string; command?: string; diff?: string; input?: string }
  | { type: 'request_user_question'; session_id: string; question_id: string; question: string; options: string[]; multi_select: boolean; header?: string }
  | { type: 'dismiss_user_question'; session_id: string; question_id: string }
  | { type: 'history_user_message'; session_id: string; content: string; created_at?: number }
  | { type: 'history_reload'; session_id: string }
  | { type: 'interrupted'; session_id: string }
  | { type: 'subscribed'; session_id: string }
  | { type: 'toast'; session_id: string; message: string; level?: string }
  | { type: 'session_deleted'; session_id: string }
  | { type: 'session_activity'; session_id: string; kind: string }
  | { type: 'unknown'; session_id?: string; raw: any };

export interface OctoAgentClientCallbacks {
  onOpen?: () => void;
  onClose?: (error?: Error) => void;
  onError?: (error: Error) => void;
  onEvent: (event: OctoAgentEvent) => void;
}

export class OctoAgentClient {
  private ws: WebSocket | null = null;
  private callbacks: OctoAgentClientCallbacks | null = null;
  onEvent?: (event: OctoAgentEvent) => void;
  private readonly reconnectDelayMs = 1000;
  private reconnectTimer: number | null = null;
  private intentionallyClosed = false;
  private pendingSubscribes = new Set<string>();
  private baseUrl: string;

  constructor(private readonly options: OctoAgentClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  connect(callbacks: OctoAgentClientCallbacks): void {
    this.callbacks = callbacks;
    this.intentionallyClosed = false;
    this.openWebSocket();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.callbacks = null;
    this.pendingSubscribes.clear();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  subscribe(sessionId: string): void {
    this.pendingSubscribes.add(sessionId);
    this.send({ type: 'subscribe', session_id: sessionId });
  }

  unsubscribe(sessionId: string): void {
    this.pendingSubscribes.delete(sessionId);
    this.send({ type: 'unsubscribe', session_id: sessionId });
  }

  sendMessage(sessionId: string, message: string, files?: OctoAgentUserFile[]): void {
    this.send({
      type: 'user_message',
      session_id: sessionId,
      content: message,
      ...(files?.length ? { files } : {}),
    });
  }

  interrupt(sessionId: string): void {
    this.send({ type: 'interrupt', session_id: sessionId });
  }

  retry(sessionId: string): void {
    this.send({ type: 'retry', session_id: sessionId });
  }

  rollback(sessionId: string): void {
    this.send({ type: 'rollback', session_id: sessionId });
  }

  confirm(id: string, result: string): void {
    this.send({ type: 'confirmation', id, result });
  }

  answerUserQuestion(
    questionId: string,
    choices: string[],
    custom: string,
    cancelled: boolean,
  ): void {
    this.send({
      type: 'user_question_answer',
      question_id: questionId,
      choices,
      custom,
      cancelled,
    });
  }

  async createSession(options: {
    name?: string;
    model?: string;
    agentProfile?: string;
    source?: string;
  } = {}): Promise<OctoAgentSession> {
    const response = await this.fetchJson('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: options.name ?? '',
        model: options.model ?? '',
        agent_profile: options.agentProfile ?? 'general',
        source: options.source ?? 'manual',
      }),
    });

    const record = response as Record<string, any>;
    if (record.session && typeof record.session === 'object') {
      return normalizeSession(record.session as Record<string, any>);
    }
    throw new Error('Invalid session creation response');
  }

  async getSessionMessages(sessionId: string): Promise<OctoAgentMessage[]> {
    const response = await this.fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
    const record = response as Record<string, any>;
    if (Array.isArray(record.events)) {
      return record.events as OctoAgentMessage[];
    }
    if (Array.isArray(record.messages)) {
      return record.messages as OctoAgentMessage[];
    }
    return [];
  }

  async setWorkingDir(sessionId: string, workingDir: string): Promise<void> {
    await this.fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/working_dir`, {
      method: 'PATCH',
      body: JSON.stringify({ working_dir: workingDir }),
    });
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: 'PATCH',
      body: JSON.stringify({ model_id: modelId }),
    });
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    await this.fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/permission_mode`, {
      method: 'PATCH',
      body: JSON.stringify({ permission_mode: mode }),
    });
  }

  async listSessions(): Promise<OctoAgentSession[]> {
    const response = await this.fetchJson('/api/sessions');
    const record = response as Record<string, any>;
    const sessions = Array.isArray(record.sessions) ? record.sessions : [];
    return sessions.map((session: any) => normalizeSession(session as Record<string, any>));
  }

  private openWebSocket(): void {
    if (this.ws) {
      return;
    }

    const url = this.buildWebSocketUrl('/ws');
    try {
      this.ws = new WebSocket(url);
    } catch (error) {
      this.callbacks?.onError?.(
        error instanceof Error ? error : new Error('Failed to create WebSocket'),
      );
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.callbacks?.onOpen?.();
      for (const sessionId of this.pendingSubscribes) {
        this.send({ type: 'subscribe', session_id: sessionId });
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.callbacks?.onClose?.();
      if (!this.intentionallyClosed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event) => {
      this.callbacks?.onError?.(
        new Error(event.type === 'error' ? 'WebSocket error' : 'WebSocket error'),
      );
    };

    this.ws.onmessage = (messageEvent) => {
      let raw: any;
      try {
        raw = JSON.parse(messageEvent.data as string);
      } catch {
        this.callbacks?.onError?.(new Error('Invalid WebSocket message'));
        return;
      }
      const event = this.parseEvent(raw);
      this.callbacks?.onEvent(event);
      this.onEvent?.(event);
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionallyClosed) {
        this.openWebSocket();
      }
    }, this.reconnectDelayMs);
  }

  private send(payload: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private async fetchJson(path: string, init?: RequestInit): Promise<unknown> {
    const url = `${this.baseUrl}${path}${this.buildAuthSuffix(path.includes('?') ? '&' : '?')}`;
    const response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return response.json();
  }

  private buildWebSocketUrl(path: string): string {
    const baseUrl = new URL(this.baseUrl);
    const protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${baseUrl.host}${path}`;
    return wsUrl + this.buildAuthSuffix('?');
  }

  private buildAuthSuffix(separator: string): string {
    if (!this.options.accessKey) {
      return '';
    }
    return `${separator}access_key=${encodeURIComponent(this.options.accessKey)}`;
  }

  private parseEvent(raw: any): OctoAgentEvent {
    const record = raw as Record<string, any>;
    const sessionId = typeof record.session_id === 'string' ? record.session_id : '';

    const type = typeof record.type === 'string' ? record.type : '';
    switch (type) {
      case 'text_delta':
      case 'thinking_delta':
      case 'output':
      case 'history_user_message':
      case 'interrupted':
      case 'history_reload':
      case 'session_deleted':
      case 'session_activity':
      case 'subscribed':
      case 'toast':
        return { ...(raw as any), type } as OctoAgentEvent;
      case 'assistant_message':
        return {
          content: asString(record.content) ?? '',
          session_id: sessionId,
          thinking: asString(record.thinking) ?? undefined,
          type: 'assistant_message',
        };
      case 'tool_call':
        return {
          args: record.args,
          name: asString(record.name) ?? '',
          session_id: sessionId,
          summary: asString(record.summary) ?? undefined,
          type: 'tool_call',
        };
      case 'tool_result':
        return {
          result: asString(record.result) ?? '',
          session_id: sessionId,
          tool_id: asString(record.tool_id) ?? undefined,
          type: 'tool_result',
          ui_payload: record.ui_payload,
        };
      case 'tool_error':
        return {
          error: asString(record.error) ?? '',
          session_id: sessionId,
          tool_id: asString(record.tool_id) ?? undefined,
          type: 'tool_error',
        };
      case 'tool_stdout':
        return {
          lines: Array.isArray(record.lines) ? record.lines.map(String) : [],
          session_id: sessionId,
          tool_id: asString(record.tool_id) ?? undefined,
          type: 'tool_stdout',
        };
      case 'progress':
        return {
          message: asString(record.message) ?? undefined,
          phase: asString(record.phase) ?? 'active',
          progress_type: asString(record.progress_type) ?? undefined,
          session_id: sessionId,
          type: 'progress',
        };
      case 'complete':
        return {
          awaiting_user_feedback: record.awaiting_user_feedback === true,
          iterations: Number(record.iterations) || 0,
          session_id: sessionId,
          type: 'complete',
        };
      case 'error':
        return {
          message: asString(record.message) ?? '',
          session_id: sessionId,
          type: 'error',
        };
      case 'session_update':
        return {
          context_usage: typeof record.context_usage === 'number' ? record.context_usage : undefined,
          permission_mode: asString(record.permission_mode) ?? undefined,
          reasoning_effort: asString(record.reasoning_effort) ?? undefined,
          session_id: sessionId,
          show_reasoning: typeof record.show_reasoning === 'boolean' ? record.show_reasoning : undefined,
          status: asString(record.status) ?? undefined,
          type: 'session_update',
          working_dir: asString(record.working_dir) ?? undefined,
        };
      case 'request_confirmation':
        return {
          command: asString(record.command) ?? undefined,
          diff: asString(record.diff) ?? undefined,
          id: asString(record.id) ?? '',
          input: asString(record.input) ?? undefined,
          kind: asString(record.kind) ?? 'yes_no',
          message: asString(record.message) ?? '',
          session_id: sessionId,
          tool_name: asString(record.tool_name) ?? undefined,
          type: 'request_confirmation',
        };
      case 'request_user_question':
        return {
          header: asString(record.header) ?? undefined,
          multi_select: record.multi_select === true,
          options: Array.isArray(record.options) ? record.options.map(String) : [],
          question: asString(record.question) ?? '',
          question_id: asString(record.question_id) ?? '',
          session_id: sessionId,
          type: 'request_user_question',
        };
      case 'dismiss_user_question':
        return {
          question_id: asString(record.question_id) ?? '',
          session_id: sessionId,
          type: 'dismiss_user_question',
        };
      default:
        return { raw: record as any, session_id: sessionId, type: 'unknown' };
    }
  }
}

function normalizeSession(record: Record<string, any>): OctoAgentSession {
  return {
    contextUsage: typeof record.context_usage === 'number' ? record.context_usage : undefined,
    id: asString(record.id) ?? '',
    name: asString(record.name) ?? '',
    permissionMode: asString(record.permission_mode) ?? undefined,
    reasoningEffort: asString(record.reasoning_effort) ?? undefined,
    showReasoning: typeof record.show_reasoning === 'boolean' ? record.show_reasoning : undefined,
    status: asString(record.status) ?? undefined,
    workingDir: asString(record.working_dir) ?? undefined,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
