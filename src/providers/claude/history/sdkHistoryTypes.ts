import type { AsyncSubagentStatus, ChatMessage } from '../../../core/types';

export interface SDKSessionReadResult {
  messages: SDKNativeMessage[];
  skippedLines: number;
  error?: string;
}

/** Stored in session JSONL files. Based on Claude Agent SDK internal format. */
export interface SDKNativeMessage {
  type: 'user' | 'assistant' | 'system' | 'result' | 'file-history-snapshot' | 'queue-operation';
  parentUuid?: string | null;
  sessionId?: string;
  uuid?: string;
  timestamp?: string;
  requestId?: string;
  message?: {
    role?: string;
    content?: string | SDKNativeContentBlock[];
    model?: string;
  };
  subtype?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  toolUseResult?: unknown;
  sourceToolAssistantUUID?: string;
  sourceToolUseID?: string;
  isMeta?: boolean;
  operation?: string;
  content?: string;
}

export interface SDKNativeContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface SDKSessionLoadResult {
  messages: ChatMessage[];
  skippedLines: number;
  error?: string;
}

export interface AsyncSubagentResult {
  result: string;
  status: string;
}

export type ResolvedAsyncStatus = Exclude<AsyncSubagentStatus, 'pending'>;
