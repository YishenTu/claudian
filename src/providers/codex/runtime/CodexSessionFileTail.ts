import * as fs from 'fs';

import type { StreamChunk, UsageInfo } from '../../../core/types/chat';
import { findCodexSessionFile } from '../history/CodexHistoryStore';
import {
  isCodexToolOutputError,
  normalizeCodexMcpToolInput,
  normalizeCodexMcpToolName,
  normalizeCodexMcpToolState,
  normalizeCodexToolInput,
  normalizeCodexToolName,
  normalizeCodexToolResult,
  parseCodexArguments,
} from '../normalization/codexToolNormalization';

// ---------------------------------------------------------------------------
// Model-specific context windows
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 200_000;

export const CODEX_CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
  'gpt-5.2': 400_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.3-codex-spark': 128_000,
};

export function getCodexContextWindow(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  return CODEX_CONTEXT_WINDOW_BY_MODEL[model] ?? DEFAULT_CONTEXT_WINDOW;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function getNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parsePayloadValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function stringifyPayloadValue(raw: unknown): string {
  try {
    const result = JSON.stringify(raw);
    return typeof result === 'string' ? result : String(raw);
  } catch {
    return String(raw);
  }
}

export function extractResponseItemMessageText(raw: unknown): string {
  if (!Array.isArray(raw)) return '';

  return raw
    .map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function extractTextFromParts(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (typeof part === 'string') return part;
      return isRecord(part) && typeof part.text === 'string' ? part.text : '';
    })
    .join('');
}

export function extractResponseItemReasoningText(raw: Record<string, unknown>): string {
  if (Array.isArray(raw.summary) && raw.summary.length > 0) {
    return extractTextFromParts(raw.summary);
  }

  if (Array.isArray(raw.content) && raw.content.length > 0) {
    return extractTextFromParts(raw.content);
  }

  return typeof raw.text === 'string' ? raw.text : '';
}

// ---------------------------------------------------------------------------
// SessionTailState
// ---------------------------------------------------------------------------

export interface ResponseItemTailState {
  emittedToolUseIds: Set<string>;
  emittedToolResultIds: Set<string>;
  knownCalls: Map<string, { toolName: string; toolInput: unknown }>;
}

export interface CallEnrichmentData {
  exitCode?: number;
  mcpServer?: string;
  mcpTool?: string;
}

export interface SessionTailState {
  responseItemState: ResponseItemTailState;
  currentTurnId: string | null;
  syntheticTurnCounter: number;
  modelContextWindow: number;
  modelContextWindowIsAuthoritative: boolean;
  lastTextByTurn: Map<string, string>;
  lastThinkingByTurn: Map<string, string>;
  pendingUsageByTurn: Map<string, {
    contextTokens: number;
    contextWindow: number;
    contextWindowIsAuthoritative: boolean;
  }>;
  emittedDoneByTurn: Set<string>;
  emittedUsageByTurn: Set<string>;
  callEnrichment: Map<string, CallEnrichmentData>;
}

export function createSessionTailState(
  fallbackContextWindow: number = DEFAULT_CONTEXT_WINDOW,
): SessionTailState {
  return {
    responseItemState: {
      emittedToolUseIds: new Set(),
      emittedToolResultIds: new Set(),
      knownCalls: new Map(),
    },
    currentTurnId: null,
    syntheticTurnCounter: 0,
    modelContextWindow: fallbackContextWindow,
    modelContextWindowIsAuthoritative: false,
    lastTextByTurn: new Map(),
    lastThinkingByTurn: new Map(),
    pendingUsageByTurn: new Map(),
    emittedDoneByTurn: new Set(),
    emittedUsageByTurn: new Set(),
    callEnrichment: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Delta emission helper
// ---------------------------------------------------------------------------

function emitDelta(
  fullText: string,
  lastSeenMap: Map<string, string>,
  turnId: string,
  chunkType: 'text' | 'thinking',
): StreamChunk[] {
  if (!fullText) return [];

  const lastSeen = lastSeenMap.get(turnId) ?? '';
  if (fullText.length <= lastSeen.length) return [];

  const delta = fullText.slice(lastSeen.length);
  lastSeenMap.set(turnId, fullText);
  return [{ type: chunkType, content: delta }];
}

// ---------------------------------------------------------------------------
// Turn ID resolution
// ---------------------------------------------------------------------------

export function resolveTurnId(
  state: SessionTailState,
  preferredTurnId: string | undefined,
): string {
  if (preferredTurnId) return preferredTurnId;
  if (state.currentTurnId) return state.currentTurnId;
  const id = `synthetic-turn-${state.syntheticTurnCounter}`;
  state.syntheticTurnCounter += 1;
  return id;
}

// ---------------------------------------------------------------------------
// Unhandled event type tracking (log-once)
// ---------------------------------------------------------------------------

const reportedUnhandledSessionEventTypes = new Set<string>();

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

export function mapSessionFileEvent(
  event: Record<string, unknown>,
  sessionId: string,
  lineIndex: number,
  state: SessionTailState,
): StreamChunk[] {
  const eventType = event.type as string | undefined;

  if (eventType === 'event_msg') {
    const payload = (event.payload ?? event) as Record<string, unknown>;
    return mapEventMsgEvent(payload, sessionId, state);
  }

  if (eventType === 'response_item') {
    return mapResponseItemEvent(event, sessionId, lineIndex, state);
  }

  if (eventType && !reportedUnhandledSessionEventTypes.has(eventType)) {
    reportedUnhandledSessionEventTypes.add(eventType);
  }

  return [];
}

// ---------------------------------------------------------------------------
// event_msg handler
// ---------------------------------------------------------------------------

export function mapEventMsgEvent(
  payload: Record<string, unknown>,
  sessionId: string,
  state: SessionTailState,
): StreamChunk[] {
  const payloadType = payload.type as string | undefined;
  const info = isRecord(payload.info) ? payload.info : {};

  switch (payloadType) {
    case 'task_started': {
      const turnId = getNonEmptyString(
        info.id,
        getNonEmptyString(payload.turn_id, `synthetic-turn-${state.syntheticTurnCounter++}`),
      );
      state.currentTurnId = turnId;
      state.modelContextWindowIsAuthoritative = false;
      if (typeof payload.model_context_window === 'number' && payload.model_context_window > 0) {
        state.modelContextWindow = payload.model_context_window;
        state.modelContextWindowIsAuthoritative = true;
      }
      return [];
    }

    case 'task_complete': {
      const turnId = resolveTurnId(state, undefined);
      const chunks: StreamChunk[] = [];

      if (!state.emittedUsageByTurn.has(turnId)) {
        const pending = state.pendingUsageByTurn.get(turnId);
        if (pending) {
          const usage = buildUsageInfo(
            pending.contextTokens,
            pending.contextWindow,
            pending.contextWindowIsAuthoritative,
          );
          chunks.push({ type: 'usage', usage, sessionId });
          state.emittedUsageByTurn.add(turnId);
        }
      }

      if (!state.emittedDoneByTurn.has(turnId)) {
        chunks.push({ type: 'done' });
        state.emittedDoneByTurn.add(turnId);
      }

      return chunks;
    }

    case 'turn_aborted': {
      const turnId = resolveTurnId(state, undefined);
      const chunks: StreamChunk[] = [];

      if (!state.emittedDoneByTurn.has(turnId)) {
        chunks.push({ type: 'done' });
        state.emittedDoneByTurn.add(turnId);
      }

      return chunks;
    }

    case 'user_message':
      return [];

    case 'agent_message': {
      const turnId = resolveTurnId(state, undefined);
      const fullText = typeof payload.text === 'string'
        ? payload.text
        : typeof payload.message === 'string'
          ? payload.message
          : '';
      return emitDelta(fullText, state.lastTextByTurn, turnId, 'text');
    }

    case 'agent_reasoning': {
      const turnId = resolveTurnId(state, undefined);
      const fullText = typeof payload.text === 'string' ? payload.text : '';
      return emitDelta(fullText, state.lastThinkingByTurn, turnId, 'thinking');
    }

    case 'token_count': {
      const turnId = resolveTurnId(state, undefined);
      const lastTokenUsage = isRecord(info.last_token_usage) ? info.last_token_usage : {};
      const inputTokens = typeof lastTokenUsage.input_tokens === 'number'
        ? lastTokenUsage.input_tokens
        : typeof lastTokenUsage.input === 'number'
          ? lastTokenUsage.input
          : 0;

      state.pendingUsageByTurn.set(turnId, {
        contextTokens: inputTokens,
        contextWindow: state.modelContextWindow,
        contextWindowIsAuthoritative: state.modelContextWindowIsAuthoritative,
      });
      return [];
    }

    case 'exec_command_end': {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      if (callId) {
        const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : undefined;
        state.callEnrichment.set(callId, {
          ...state.callEnrichment.get(callId),
          exitCode,
        });
      }
      return [];
    }

    case 'patch_apply_end': {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      if (callId && typeof payload.success === 'boolean' && !payload.success) {
        state.callEnrichment.set(callId, {
          ...state.callEnrichment.get(callId),
          exitCode: 1,
        });
      }
      return [];
    }

    case 'mcp_tool_call_end': {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      const invocation = isRecord(payload.invocation) ? payload.invocation : {};
      if (callId && typeof invocation.server === 'string' && typeof invocation.tool === 'string') {
        state.callEnrichment.set(callId, {
          ...state.callEnrichment.get(callId),
          mcpServer: invocation.server,
          mcpTool: invocation.tool,
        });
        // Update the known call's tool name so the tool_result uses the MCP-prefixed name
        const known = state.responseItemState.knownCalls.get(callId);
        if (known) {
          known.toolName = `mcp__${invocation.server}__${invocation.tool}`;
        }
      }
      return [];
    }

    case 'web_search_end':
    case 'view_image_tool_call':
    case 'collab_agent_spawn_end':
    case 'collab_waiting_end':
    case 'collab_close_end':
      return [];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// response_item handler
// ---------------------------------------------------------------------------

export function mapResponseItemEvent(
  event: Record<string, unknown>,
  sessionId: string,
  lineIndex: number,
  state: SessionTailState,
): StreamChunk[] {
  const payload = isRecord(event.payload) ? event.payload : {};
  const payloadType = payload.type as string | undefined;
  const riState = state.responseItemState;

  switch (payloadType) {
    case 'message': {
      if (payload.role !== 'assistant') return [];

      const turnId = resolveTurnId(state, undefined);
      const fullText = extractResponseItemMessageText(payload.content);
      return emitDelta(fullText, state.lastTextByTurn, turnId, 'text');
    }

    case 'reasoning': {
      const turnId = resolveTurnId(state, undefined);
      const fullText = extractResponseItemReasoningText(payload);
      return emitDelta(fullText, state.lastThinkingByTurn, turnId, 'thinking');
    }

    case 'function_call':
    case 'custom_tool_call': {
      const callId = getNonEmptyString(payload.call_id, `tail-call-${lineIndex}`);
      if (riState.emittedToolUseIds.has(callId)) return [];
      riState.emittedToolUseIds.add(callId);

      const rawName = typeof payload.name === 'string' ? payload.name : undefined;
      const rawArgs = typeof payload.arguments === 'string'
        ? payload.arguments
        : typeof payload.input === 'string'
          ? payload.input
          : undefined;
      const parsedArgs = parseCodexArguments(rawArgs);

      // Use MCP enrichment if available (mcp_tool_call_end may arrive before function_call)
      const enrichment = state.callEnrichment.get(callId);
      const normalizedName = enrichment?.mcpServer && enrichment?.mcpTool
        ? `mcp__${enrichment.mcpServer}__${enrichment.mcpTool}`
        : normalizeCodexToolName(rawName);
      const normalizedInput = normalizeCodexToolInput(rawName, parsedArgs);

      riState.knownCalls.set(callId, { toolName: normalizedName, toolInput: normalizedInput });

      return [{
        type: 'tool_use',
        id: callId,
        name: normalizedName,
        input: normalizedInput,
      }];
    }

    case 'web_search_call': {
      const callId = getNonEmptyString(payload.call_id, `tail-ws-${lineIndex}`);
      if (riState.emittedToolUseIds.has(callId)) return [];
      riState.emittedToolUseIds.add(callId);

      const input = normalizeCodexToolInput('web_search_call', {
        action: payload.action ?? {},
      });

      riState.knownCalls.set(callId, { toolName: 'WebSearch', toolInput: input });

      const chunks: StreamChunk[] = [{
        type: 'tool_use',
        id: callId,
        name: 'WebSearch',
        input,
      }];

      // Persisted web_search_call includes final status — emit tool_result immediately
      if (payload.status) {
        riState.emittedToolResultIds.add(callId);
        chunks.push({
          type: 'tool_result',
          id: callId,
          content: 'Search complete',
          isError: payload.status === 'failed' || payload.status === 'error',
        });
      }

      return chunks;
    }

    case 'mcp_tool_call': {
      const callId = getNonEmptyString(payload.call_id, `tail-mcp-${lineIndex}`);
      const normalizedName = normalizeCodexMcpToolName(payload.server, payload.tool);
      const normalizedInput = normalizeCodexMcpToolInput(payload.arguments);
      const normalizedState = normalizeCodexMcpToolState(payload.status, payload.result, payload.error);
      const chunks: StreamChunk[] = [];

      riState.knownCalls.set(callId, { toolName: normalizedName, toolInput: normalizedInput });

      if (!riState.emittedToolUseIds.has(callId)) {
        riState.emittedToolUseIds.add(callId);
        chunks.push({
          type: 'tool_use',
          id: callId,
          name: normalizedName,
          input: normalizedInput,
        });
      }

      if (normalizedState.isTerminal && !riState.emittedToolResultIds.has(callId)) {
        riState.emittedToolResultIds.add(callId);
        chunks.push({
          type: 'tool_result',
          id: callId,
          content: normalizedState.result ?? (normalizedState.isError ? 'Failed' : 'Completed'),
          isError: normalizedState.isError,
        });
      }

      return chunks;
    }

    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = getNonEmptyString(payload.call_id, `tail-out-${lineIndex}`);
      if (riState.emittedToolResultIds.has(callId)) return [];
      riState.emittedToolResultIds.add(callId);

      const known = riState.knownCalls.get(callId);
      const normalizedName = known?.toolName ?? 'tool';
      const enrichment = state.callEnrichment.get(callId);

      // Image content: view_image returns array of {type: "input_image", image_url: "data:..."}
      if (Array.isArray(payload.output)) {
        const imagePath = known?.toolInput
          && typeof (known.toolInput as Record<string, unknown>).file_path === 'string'
          ? (known.toolInput as Record<string, unknown>).file_path as string
          : 'Image loaded';
        return [{
          type: 'tool_result',
          id: callId,
          content: imagePath,
          isError: false,
        }];
      }

      const rawOutput = typeof payload.output === 'string' ? payload.output : stringifyPayloadValue(payload.output);
      const content = normalizeCodexToolResult(normalizedName, rawOutput);

      // Prefer enrichment exit_code over regex-based error detection
      const isError = enrichment?.exitCode !== undefined
        ? enrichment.exitCode !== 0
        : isCodexToolOutputError(rawOutput);

      return [{
        type: 'tool_result',
        id: callId,
        content,
        isError,
      }];
    }

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Usage builder
// ---------------------------------------------------------------------------

function buildUsageInfo(
  contextTokens: number,
  contextWindow: number,
  contextWindowIsAuthoritative: boolean,
): UsageInfo {
  return {
    inputTokens: contextTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    contextWindow,
    contextWindowIsAuthoritative,
    contextTokens,
    percentage: contextWindow > 0 ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100))) : 0,
  };
}

// ---------------------------------------------------------------------------
// File-tail polling engine
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

export class CodexFileTailEngine {
  private tailState: SessionTailState;
  private tailSessionFile: string | null = null;
  private tailLineCursor = 0;
  private pendingEvents: StreamChunk[] = [];
  private pollingActive = false;
  private pollPromise: Promise<void> | null = null;
  private pollingError: Error | null = null;
  private lastEventAt = 0;
  private lastPollAt = 0;
  private consecutiveReadFailures = 0;

  private _turnCompleteEmitted = false;
  private _usageEmitted = false;

  constructor(
    private sessionsDir: string,
    private defaultContextWindow: number,
  ) {
    this.tailState = createSessionTailState(defaultContextWindow);
  }

  get turnCompleteEmitted(): boolean {
    return this._turnCompleteEmitted;
  }

  get usageEmitted(): boolean {
    return this._usageEmitted;
  }

  async primeCursor(sessionId: string, sessionFilePath?: string): Promise<boolean> {
    const filePath = this.findSessionFile(sessionId, sessionFilePath);
    if (!filePath) return false;

    const lines = this.readFileLines(filePath);
    this.tailLineCursor = lines.length;
    return true;
  }

  startPolling(sessionId: string, sessionFilePath?: string): boolean {
    const filePath = this.findSessionFile(sessionId, sessionFilePath);
    if (!filePath) {
      return false;
    }

    this.tailSessionFile = filePath;
    this.pollingActive = true;
    this.pollingError = null;
    this.pollPromise = this.pollLoop(sessionId);
    return true;
  }

  async stopPolling(): Promise<void> {
    this.pollingActive = false;
    if (this.pollPromise) {
      await this.pollPromise;
      this.pollPromise = null;
    }
  }

  async waitForSettle(): Promise<void> {
    const maxWait = 2500;
    const checkInterval = 80;
    const idleThreshold = 500;
    const pollRecencyThreshold = 250;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      const now = Date.now();
      const idle = this.lastEventAt > 0 ? now - this.lastEventAt : now - start;
      const pollRecent = this.lastPollAt > 0 && (now - this.lastPollAt) < pollRecencyThreshold;

      if (idle >= idleThreshold && pollRecent) {
        return;
      }

      await sleep(checkInterval);
    }
  }

  collectPendingEvents(): StreamChunk[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  consumePollingError(): Error | null {
    const error = this.pollingError;
    this.pollingError = null;
    return error;
  }

  resetForNewTurn(): void {
    this.tailState = createSessionTailState(this.defaultContextWindow);
    this.pendingEvents = [];
    this._turnCompleteEmitted = false;
    this._usageEmitted = false;
    this.pollingError = null;
    this.lastEventAt = 0;
    this.lastPollAt = 0;
    this.consecutiveReadFailures = 0;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private async pollLoop(sessionId: string): Promise<void> {
    try {
      while (this.pollingActive) {
        const events = this.drainSessionFileEvents(sessionId);
        if (events.length > 0) {
          this.pendingEvents.push(...events);
          this.lastEventAt = Date.now();
          this.trackTailFlags(events);
        }
        this.lastPollAt = Date.now();
        await sleep(100);
      }

      // Final drain after stop
      const finalEvents = this.drainSessionFileEvents(sessionId);
      if (finalEvents.length > 0) {
        this.pendingEvents.push(...finalEvents);
        this.trackTailFlags(finalEvents);
      }
    } catch (error: unknown) {
      this.pollingError = error instanceof Error
        ? error
        : new Error(String(error));
      this.pollingActive = false;
    } finally {
      this.lastPollAt = Date.now();
    }
  }

  private drainSessionFileEvents(sessionId: string): StreamChunk[] {
    if (!sessionId) return [];

    const filePath = this.findSessionFile(sessionId);
    if (!filePath) return [];

    let lines: string[];
    try {
      lines = this.readFileLines(filePath);
      this.consecutiveReadFailures = 0;
    } catch {
      this.consecutiveReadFailures += 1;
      if (this.consecutiveReadFailures >= 5) {
        throw new Error(`CodexFileTailEngine: 5 consecutive read failures for ${filePath}`);
      }
      return [];
    }

    // Handle rotation: cursor beyond file length
    if (this.tailLineCursor > lines.length) {
      this.tailLineCursor = 0;
    }

    if (this.tailLineCursor >= lines.length) return [];

    const newLines = lines.slice(this.tailLineCursor);
    const startIndex = this.tailLineCursor;
    this.tailLineCursor = lines.length;

    const chunks: StreamChunk[] = [];
    for (let i = 0; i < newLines.length; i++) {
      const line = newLines[i];
      if (!line.trim()) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const mapped = mapSessionFileEvent(parsed, sessionId, startIndex + i, this.tailState);
      chunks.push(...mapped);
    }

    return chunks;
  }

  private findSessionFile(sessionId: string, sessionFilePath?: string): string | null {
    if (sessionFilePath && fs.existsSync(sessionFilePath)) {
      this.tailSessionFile = sessionFilePath;
      return sessionFilePath;
    }

    if (this.tailSessionFile) {
      try {
        if (fs.existsSync(this.tailSessionFile)) {
          return this.tailSessionFile;
        }
      } catch {
        // fall through and refind
      }

      this.tailSessionFile = null;
    }

    const filePath = findCodexSessionFile(sessionId, this.sessionsDir);
    if (filePath) {
      this.tailSessionFile = filePath;
    }

    return filePath;
  }

  private readFileLines(filePath: string): string[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').filter(line => line.trim());
  }

  private trackTailFlags(events: StreamChunk[]): void {
    for (const event of events) {
      if (event.type === 'done') {
        this._turnCompleteEmitted = true;
      }
      if (event.type === 'usage') {
        this._usageEmitted = true;
      }
    }
  }
}
