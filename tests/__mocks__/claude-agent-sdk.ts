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
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  abortController?: AbortController;
  pathToClaudeCodeExecutable?: string;
  resume?: string;
  maxThinkingTokens?: number;
  canUseTool?: CanUseTool;
  systemPrompt?: string | { content: string; cacheControl?: { type: string } };
  mcpServers?: Record<string, unknown>;
  settingSources?: ('user' | 'project' | 'local')[];
  hooks?: {
    PreToolUse?: HookCallbackMatcher[];
  };
}

// Type exports that match the real SDK
export type CanUseTool = (toolName: string, input: Record<string, unknown>, options: any) => Promise<PermissionResult>;
export type PermissionResult = { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string; interrupt?: boolean };

// Default mock messages for testing
const mockMessages = [
  { type: 'system', subtype: 'init', session_id: 'test-session-123' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello, I am Claude!' }] } },
  { type: 'result', result: 'completed' },
];

let customMockMessages: any[] | null = null;
let appendResultMessage = true;
let lastOptions: Options | undefined;
let lastResponse: (AsyncGenerator<any> & {
  interrupt: jest.Mock;
  setModel: jest.Mock;
  setMaxThinkingTokens: jest.Mock;
  setPermissionMode: jest.Mock;
  setMcpServers: jest.Mock;
}) | null = null;

// Crash simulation control
let shouldThrowOnIteration = false;
let throwAfterChunks = 0;
let queryCallCount = 0;

// Allow tests to set custom mock messages
export function setMockMessages(messages: any[], options?: { appendResult?: boolean }) {
  customMockMessages = messages;
  appendResultMessage = options?.appendResult ?? true;
}

export function resetMockMessages() {
  customMockMessages = null;
  appendResultMessage = true;
  lastOptions = undefined;
  lastResponse = null;
  shouldThrowOnIteration = false;
  throwAfterChunks = 0;
  queryCallCount = 0;
}

/**
 * Configure the mock to throw an error during iteration.
 * @param afterChunks - Number of chunks to emit before throwing (0 = throw immediately)
 */
export function simulateCrash(afterChunks = 0) {
  shouldThrowOnIteration = true;
  throwAfterChunks = afterChunks;
}

/**
 * Get the number of times query() was called (useful for verifying restart behavior).
 */
export function getQueryCallCount(): number {
  return queryCallCount;
}

export function getLastOptions(): Options | undefined {
  return lastOptions;
}

export function getLastResponse(): typeof lastResponse {
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
function isAsyncIterable(value: any): value is AsyncIterable<any> {
  return !!value && typeof value[Symbol.asyncIterator] === 'function';
}

function getMessagesForPrompt(): any[] {
  const baseMessages = customMockMessages || mockMessages;
  const messages = [...baseMessages];
  if (appendResultMessage && !messages.some((msg) => msg.type === 'result')) {
    messages.push({ type: 'result' });
  }
  return messages;
}

async function* emitMessages(messages: any[], options: Options) {
  let chunksEmitted = 0;

  for (const msg of messages) {
    // Check if we should throw (crash simulation)
    if (shouldThrowOnIteration && chunksEmitted >= throwAfterChunks) {
      // Reset for next query (allows recovery to work)
      shouldThrowOnIteration = false;
      throw new Error('Simulated consumer crash');
    }

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
            chunksEmitted++;
            // Then yield a blocked indicator as a user message with error
            yield {
              type: 'user',
              parent_tool_use_id: block.id,
              tool_use_result: `BLOCKED: ${hookResult.reason}`,
              message: { content: [] },
              _blocked: true,
              _blockReason: hookResult.reason,
            };
            chunksEmitted++;
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
    chunksEmitted++;
  }
}

export function query({ prompt, options }: { prompt: any; options: Options }): AsyncGenerator<any> & { interrupt: () => Promise<void> } {
  lastOptions = options;
  queryCallCount++;

  const generator = async function* () {
    if (isAsyncIterable(prompt)) {
      for await (const _ of prompt) {
        void _; // Consume async iterable input
        const messages = getMessagesForPrompt();
        yield* emitMessages(messages, options);
      }
      return;
    }

    const messages = getMessagesForPrompt();
    yield* emitMessages(messages, options);
  };

  const gen = generator() as AsyncGenerator<any> & {
    interrupt: jest.Mock;
    setModel: jest.Mock;
    setMaxThinkingTokens: jest.Mock;
    setPermissionMode: jest.Mock;
    setMcpServers: jest.Mock;
  };
  gen.interrupt = jest.fn().mockResolvedValue(undefined);
  // Dynamic update methods for persistent queries
  gen.setModel = jest.fn().mockResolvedValue(undefined);
  gen.setMaxThinkingTokens = jest.fn().mockResolvedValue(undefined);
  gen.setPermissionMode = jest.fn().mockResolvedValue(undefined);
  gen.setMcpServers = jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} });
  lastResponse = gen;

  return gen;
}
