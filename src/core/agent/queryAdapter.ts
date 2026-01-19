/**
 * Query Adapter - Unified query interface for both Claude and iFlow SDKs
 *
 * Provides a common interface for making queries regardless of the backend SDK.
 * Used by services that need direct SDK access (InlineEdit, TitleGeneration, etc.)
 */

import { SDK_BACKEND } from './config';

// ============================================
// Types
// ============================================

/** Common options for queries */
export interface QueryAdapterOptions {
  cwd: string;
  systemPrompt?: string;
  model?: string;
  abortController?: AbortController;
  cliPath?: string;
  env?: Record<string, string>;
  tools?: string[];
  maxThinkingTokens?: number;
  resume?: string;
  settingSources?: Array<'user' | 'project'>;
  hooks?: {
    PreToolUse?: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
    PostToolUse?: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
  };
}

/** Message from the query stream */
export interface QueryMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }>;
  };
  event?: {
    type: string;
    content_block?: {
      type: string;
      text?: string;
      thinking?: string;
    };
    delta?: {
      type: string;
      text?: string;
      thinking?: string;
    };
  };
}

/** Query response interface */
export interface QueryResponse {
  [Symbol.asyncIterator](): AsyncIterator<QueryMessage>;
  interrupt(): Promise<void>;
}

// ============================================
// Claude SDK Adapter
// ============================================

function queryWithClaude(
  prompt: string,
  options: QueryAdapterOptions
): Promise<QueryResponse> {
  // Dynamic import to avoid loading Claude SDK when using iFlow
  return import('@anthropic-ai/claude-agent-sdk').then(({ query: agentQuery }: { query: (opts: { prompt: string; options: Record<string, unknown> }) => QueryResponse }) => {
    const claudeOptions: Record<string, unknown> = {
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      model: options.model,
      abortController: options.abortController,
      pathToClaudeCodeExecutable: options.cliPath,
      env: options.env,
      tools: options.tools,
      maxThinkingTokens: options.maxThinkingTokens,
      resume: options.resume,
      settingSources: options.settingSources,
      hooks: options.hooks,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    };

    return agentQuery({ prompt, options: claudeOptions }) as QueryResponse;
  });
}

// ============================================
// iFlow SDK Adapter
// ============================================

function queryWithIFlow(
  prompt: string,
  options: QueryAdapterOptions
): Promise<QueryResponse> {
  return import('../iflow/IFlowClient').then(({ IFlowClient }) => {
    const client = new IFlowClient({
      cwd: options.cwd,
      env: options.env,
    });

    let sessionId: string | null = null;
    let connected = false;

    const iterator = {
      next(): Promise<IteratorResult<QueryMessage, undefined>> {
        const doNext = () => {
          const iflowIterator = client.sendMessage(prompt, {
            model: options.model,
            systemPrompt: options.systemPrompt,
            maxThinkingTokens: options.maxThinkingTokens,
            sessionId: options.resume,
            tools: options.tools,
          });

          return iflowIterator.next().then((result) => {
            if (result.done) {
              return { done: true as const, value: undefined };
            }

            // Capture session ID
            if (!sessionId) {
              sessionId = client.getSessionId();
            }

            // Transform iFlow message to Claude SDK format
            const queryMsg = transformIFlowToQueryMessage(result.value, sessionId);
            return { done: false as const, value: queryMsg };
          });
        };

        if (!connected) {
          return client.connect().then(() => {
            connected = true;
            return doNext();
          });
        }

        return doNext();
      },
    };

    return {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      interrupt() {
        return client.interrupt().then(() => client.disconnect());
      },
    };
  });
}

/**
 * Transform iFlow message to Claude SDK message format.
 */
function transformIFlowToQueryMessage(
  msg: { type: string; chunk?: { text: string }; content?: string; toolName?: string; status?: string; result?: string; stopReason?: string; message?: string },
  sessionId: string | null
): QueryMessage {
  switch (msg.type) {
    case 'assistant':
      return {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: msg.chunk?.text || '' }],
        },
      };

    case 'thinking':
      return {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: msg.content || '' }],
        },
      };

    case 'tool_call':
      if (msg.status === 'completed' || msg.status === 'failed') {
        return {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', text: msg.result || '' }],
          },
        };
      }
      return {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: msg.toolName || '' }],
        },
      };

    case 'task_finish':
      return {
        type: 'result',
        subtype: 'success',
      };

    case 'error':
      return {
        type: 'error',
        message: { content: [{ type: 'text', text: msg.message || 'Unknown error' }] },
      };

    default:
      // Return session init for first message
      if (sessionId) {
        return {
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
        };
      }
      return { type: 'unknown' };
  }
}

// ============================================
// Public API
// ============================================

/**
 * Execute a query using the configured SDK backend.
 *
 * @param prompt - The prompt to send
 * @param options - Query options
 * @returns Promise of async iterable of messages
 */
export function query(
  prompt: string,
  options: QueryAdapterOptions
): Promise<QueryResponse> {
  if (SDK_BACKEND === 'iflow') {
    return queryWithIFlow(prompt, options);
  }
  return queryWithClaude(prompt, options);
}

/**
 * Check if using iFlow backend.
 */
export function isUsingIFlow(): boolean {
  return SDK_BACKEND === 'iflow';
}
