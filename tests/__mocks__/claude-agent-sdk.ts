// Mock for @anthropic-ai/claude-agent-sdk

export interface HookCallbackMatcher {
  matcher?: string;
  hooks: Array<(hookInput: any, toolUseID: string, options: any) => Promise<{ continue: boolean; hookSpecificOutput?: any }>>;
}

export interface Options {
  cwd?: string;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  abortController?: AbortController;
  pathToClaudeCodeExecutable?: string;
  resume?: string;
  maxThinkingTokens?: number;
  canUseTool?: CanUseTool;
  systemPrompt?: string | { content: string; cacheControl?: { type: string } };
  mcpServers?: Record<string, unknown>;
  hooks?: {
    PreToolUse?: HookCallbackMatcher[];
  };
}

// Type exports that match the real SDK
export type CanUseTool = (toolName: string, input: Record<string, unknown>, options: any) => Promise<PermissionResult>;
export type PermissionResult = { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string; interrupt?: boolean };

// Query type that includes dynamic update methods
interface Query extends AsyncGenerator<any> {
  interrupt: jest.Mock;
  setModel: jest.Mock;
  setMcpServers: jest.Mock;
  setPermissionMode: jest.Mock;
  setMaxThinkingTokens: jest.Mock;
}

// Default mock messages for testing
const mockMessages = [
  { type: 'system', subtype: 'init', session_id: 'test-session-123' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello, I am Claude!' }] } },
  { type: 'result', result: 'completed' },
];

let customMockMessages: any[] | null = null;
let lastOptions: Options | undefined;
let lastResponse: Query | null = null;

// Allow tests to set custom mock messages
export function setMockMessages(messages: any[]) {
  customMockMessages = messages;
}

export function resetMockMessages() {
  customMockMessages = null;
  lastOptions = undefined;
  lastResponse = null;
}

export function getLastOptions(): Options | undefined {
  return lastOptions;
}

export function getLastResponse(): Query | null {
  return lastResponse;
}

// Helper to run PreToolUse hooks
async function runPreToolUseHooks(
  hooks: HookCallbackMatcher[] | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolId: string
): Promise<{ blocked: boolean; reason?: string }> {
  if (!hooks) return { blocked: false };

  for (const hookMatcher of hooks) {
    // Check if matcher matches the tool (no matcher = match all)
    if (hookMatcher.matcher && hookMatcher.matcher !== toolName) {
      continue;
    }

    for (const hookFn of hookMatcher.hooks) {
      const hookInput = { tool_name: toolName, tool_input: toolInput };
      const result = await hookFn(hookInput, toolId, {});

      if (!result.continue) {
        const reason = result.hookSpecificOutput?.permissionDecisionReason || 'Blocked by hook';
        return { blocked: true, reason };
      }
    }
  }

  return { blocked: false };
}

// Mock query function that returns an async generator
// Supports both string prompts (old behavior) and AsyncIterable prompts (streaming mode)
export function query({ prompt, options }: { prompt: string | AsyncIterable<any>; options: Options }): Query {
  const messages = customMockMessages || mockMessages;
  lastOptions = options;

  // Check if prompt is an AsyncIterable (streaming mode)
  const isStreamingMode = typeof prompt !== 'string' && prompt !== null && typeof (prompt as any)[Symbol.asyncIterator] === 'function';

  const generator = async function* () {
    if (isStreamingMode) {
      // Streaming mode: consume messages from the prompt generator
      // and yield responses for each message
      const promptIterable = prompt as AsyncIterable<any>;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _userMsg of promptIterable) {
        // For each user message, yield the configured mock responses
        for (const msg of messages) {
          // Check for tool_use in assistant messages and run hooks
          if (msg.type === 'assistant' && msg.message?.content) {
            let wasBlocked = false;
            for (const block of msg.message.content) {
              if (block.type === 'tool_use') {
                const hookResult = await runPreToolUseHooks(
                  options.hooks?.PreToolUse,
                  block.name,
                  block.input,
                  block.id || `tool-${Date.now()}`
                );

                if (hookResult.blocked) {
                  // Yield the assistant message first (with tool_use)
                  yield msg;
                  // Then yield a blocked indicator as a user message with error
                  yield {
                    type: 'user',
                    parent_tool_use_id: block.id,
                    tool_use_result: `BLOCKED: ${hookResult.reason}`,
                    message: { content: [] },
                    _blocked: true,
                    _blockReason: hookResult.reason,
                  };
                  wasBlocked = true;
                  break; // Exit inner loop since we already handled this message
                }
              }
            }
            // If the message was blocked, don't yield it again
            if (wasBlocked) {
              continue;
            }
          }
          yield msg;
        }
      }
    } else {
      // Original mode: yield all messages once for string prompt
      for (const msg of messages) {
        // Check for tool_use in assistant messages and run hooks
        if (msg.type === 'assistant' && msg.message?.content) {
          let wasBlocked = false;
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              const hookResult = await runPreToolUseHooks(
                options.hooks?.PreToolUse,
                block.name,
                block.input,
                block.id || `tool-${Date.now()}`
              );

              if (hookResult.blocked) {
                // Yield the assistant message first (with tool_use)
                yield msg;
                // Then yield a blocked indicator as a user message with error
                yield {
                  type: 'user',
                  parent_tool_use_id: block.id,
                  tool_use_result: `BLOCKED: ${hookResult.reason}`,
                  message: { content: [] },
                  _blocked: true,
                  _blockReason: hookResult.reason,
                };
                wasBlocked = true;
                break; // Exit inner loop since we already handled this message
              }
            }
          }
          // If the message was blocked, don't yield it again
          if (wasBlocked) {
            continue;
          }
        }
        yield msg;
      }
    }
  };

  const gen = generator() as Query;
  gen.interrupt = jest.fn().mockResolvedValue(undefined);
  // Add dynamic update methods
  gen.setModel = jest.fn().mockResolvedValue(undefined);
  gen.setMcpServers = jest.fn().mockResolvedValue(undefined);
  gen.setPermissionMode = jest.fn().mockResolvedValue(undefined);
  gen.setMaxThinkingTokens = jest.fn().mockResolvedValue(undefined);
  lastResponse = gen;

  return gen;
}
