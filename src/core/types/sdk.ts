/**
 * Claude Agent SDK type definitions.
 */

/** SDK content block structure. */
export interface SDKContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | unknown;
  is_error?: boolean;
}

/** SDK message content wrapper. */
export interface SDKMessageContent {
  content?: SDKContentBlock[];
}

/** SDK stream event structure. */
export interface SDKStreamEvent {
  type: 'content_block_start' | 'content_block_delta';
  index?: number;
  content_block?: SDKContentBlock;
  delta?: {
    type: 'text_delta' | 'thinking_delta';
    text?: string;
    thinking?: string;
  };
}

/** SDK message structure from the Claude Agent SDK. */
export interface SDKMessage {
  type: 'system' | 'assistant' | 'user' | 'stream_event' | 'result' | 'error' | 'tool_progress' | 'auth_status';
  subtype?: 'init' | 'compact_boundary' | 'status' | 'hook_response' | string;
  session_id?: string;
  message?: SDKMessageContent;
  tool_use_result?: string | unknown;
  parent_tool_use_id?: string | null;
  event?: SDKStreamEvent;
  error?: string;
  tool_use_id?: string;
  tool_name?: string;
  elapsed_time_seconds?: number;
  isAuthenticating?: boolean;
  output?: string[];
}
