import type { Query, SDKControlInitializeResponse, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Mock } from 'vitest';

// Mock for @anthropic-ai/claude-agent-sdk

export type { HookCallbackMatcher, SpawnedProcess,SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallbackMatcher, SpawnedProcess,SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

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
  thinking?: { type: string; budgetTokens?: number };
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  canUseTool?: CanUseTool;
  systemPrompt?: string | { content: string; cacheControl?: { type: string } };
  mcpServers?: Record<string, unknown>;
  settingSources?: ('user' | 'project' | 'local')[];
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  hooks?: {
    PreToolUse?: HookCallbackMatcher[];
    PostToolUse?: HookCallbackMatcher[];
    Stop?: HookCallbackMatcher[];
  };
  agents?: Record<string, AgentDefinition>;
  persistSession?: boolean;
}

export interface Settings {
  effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

// Type exports that match the real SDK
export type AgentDefinition = {
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  prompt: string;
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  mcpServers?: unknown[];
  skills?: string[];
  maxTurns?: number;
  hooks?: Record<string, unknown>;
};

export type PermissionBehavior = 'allow' | 'deny' | 'ask';

export type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
};

export type PermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';

export type PermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'delegate' | 'dontAsk' | 'plan';

export type PermissionUpdate =
  | { type: 'addRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'replaceRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'removeRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'setMode'; mode: PermissionMode; destination: PermissionUpdateDestination }
  | { type: 'addDirectories'; directories: string[]; destination: PermissionUpdateDestination }
  | { type: 'removeDirectories'; directories: string[]; destination: PermissionUpdateDestination };

export type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {
  signal: AbortSignal;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
  toolUseID: string;
  agentID?: string;
}) => Promise<PermissionResult>;

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; toolUseID?: string }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string };

export type ModelInfo = {
  value: string;
  displayName: string;
  description: string;
  resolvedModel?: string;
  supportedEffortLevels?: string[];
};

// Default mock messages for testing
const mockMessages = [
  { type: 'system', subtype: 'init', session_id: 'test-session-123' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello, I am Claude!' }] } },
  { type: 'result', subtype: 'success', result: 'completed' },
];

let customMockMessages: unknown[] | null = null;
let appendResultMessage = true;
let lastOptions: Options | undefined;
let lastPrompt: unknown;
let mockInitialization: (() => Promise<SDKControlInitializeResponse>) | undefined;
let mockSupportedCommands: Array<{ name: string; description: string; argumentHint?: string }> = [];
let mockSupportedCommandsImplementation: (() => Promise<Array<{
  name: string;
  description: string;
  argumentHint?: string;
}>>) | null = null;
let mockSupportedModels: ModelInfo[] = [];
let mockOutputStyles: string[] = [];
let mockContextUsage: { rawMaxTokens: number } | null = null;
let lastResponse: (AsyncGenerator<unknown> & {
  interrupt: Mock<Query['interrupt']>;
  setModel: Mock<Query['setModel']>;
  setMaxThinkingTokens: Mock;
  setPermissionMode: Mock<Query['setPermissionMode']>;
  applyFlagSettings: Mock<Query['applyFlagSettings']>;
  setMcpServers: Mock<Query['setMcpServers']>;
  supportedCommands: Mock<Query['supportedCommands']>;
  initializationResult: Mock<Query['initializationResult']>;
  close: Mock<Query['close']>;
  getContextUsage: Mock;
}) | null = null;

let queryCallCount = 0;
let receivedMessages: unknown[] = [];

// Allow tests to set custom mock messages
export function setMockMessages(messages: unknown[], options?: { appendResult?: boolean }) {
  customMockMessages = messages;
  appendResultMessage = options?.appendResult ?? true;
}

export function resetMockMessages() {
  customMockMessages = null;
  appendResultMessage = true;
  lastOptions = undefined;
  lastPrompt = undefined;
  mockInitialization = undefined;
  mockSupportedCommands = [];
  mockSupportedCommandsImplementation = null;
  mockSupportedModels = [];
  mockOutputStyles = [];
  mockContextUsage = null;
  lastResponse = null;
  queryCallCount = 0;
  receivedMessages = [];
}

export function setMockSupportedCommands(
  commands: Array<{ name: string; description: string; argumentHint?: string }>
) {
  mockSupportedCommands = commands;
}

export function setMockSupportedCommandsImplementation(
  implementation: () => Promise<Array<{
    name: string;
    description: string;
    argumentHint?: string;
  }>>,
) {
  mockSupportedCommandsImplementation = implementation;
}

export function setMockSupportedModels(models: ModelInfo[]) {
  mockSupportedModels = models;
}

export function setMockOutputStyles(styles: string[]) {
  mockOutputStyles = styles;
}

export function setMockContextUsage(contextUsage: { rawMaxTokens: number } | null) {
  mockContextUsage = contextUsage;
}

/**
 * Get the number of times query() was called (useful for verifying restart behavior).
 */
export function getQueryCallCount(): number {
  return queryCallCount;
}

/** Native inputs actually consumed by the SDK query port. */
export function getReceivedMessages(): readonly unknown[] {
  return receivedMessages;
}

export function setMockInitializationResult(implementation: () => Promise<SDKControlInitializeResponse>): void {
  mockInitialization = implementation;
}

export function getLastPrompt(): unknown { return lastPrompt; }

export function getLastOptions(): Options | undefined {
  return lastOptions;
}

export function getLastResponse(): typeof lastResponse {
  return lastResponse;
}

// Mock query function that returns an async generator
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === 'object' && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === 'function';
}

function getMessagesForPrompt(): unknown[] {
  const baseMessages = customMockMessages || mockMessages;
  const messages = [...baseMessages];
  if (appendResultMessage && !messages.some((msg) => msg !== null && typeof msg === 'object' && 'type' in msg && msg.type === 'result')) {
    messages.push({ type: 'result', subtype: 'success' });
  }
  return messages;
}

// Pending entries act as barriers; one that resolves to null emits nothing.
async function* emitMessages(messages: unknown[]) {
  for (const pendingMessage of messages) {
    const message = await pendingMessage;
    if (message && typeof message === 'object' && 'type' in message && message.type === 'system' && 'subtype' in message && message.subtype === 'commands_changed' && 'commands' in message) {
      mockSupportedCommands = message.commands as Awaited<ReturnType<Query['supportedCommands']>>;
    }
    if (message != null) yield message;
  }
}

export function query({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }): AsyncGenerator<unknown> & Pick<Query, 'interrupt'> {
  lastOptions = options;
  lastPrompt = prompt;
  queryCallCount++;

  const generator = async function* () {
    if (isAsyncIterable(prompt)) {
      for await (const message of prompt) {
        receivedMessages.push(message);
        const messages = getMessagesForPrompt();
        yield* emitMessages(messages);
      }
      return;
    }

    const messages = getMessagesForPrompt();
    yield* emitMessages(messages);
  };

  const gen = generator() as AsyncGenerator<unknown> & {
    interrupt: Mock<Query['interrupt']>;
    setModel: Mock<Query['setModel']>;
    setMaxThinkingTokens: Mock;
    setPermissionMode: Mock<Query['setPermissionMode']>;
    applyFlagSettings: Mock<Query['applyFlagSettings']>;
    setMcpServers: Mock<Query['setMcpServers']>;
    supportedCommands: Mock<Query['supportedCommands']>;
    initializationResult: Mock<Query['initializationResult']>;
    close: Mock<Query['close']>;
    getContextUsage: Mock;
  };
  gen.interrupt = vi.fn().mockResolvedValue(undefined);
  // Dynamic update methods for persistent queries
  gen.setModel = vi.fn().mockResolvedValue(undefined);
  gen.setMaxThinkingTokens = vi.fn().mockResolvedValue(undefined);
  gen.setPermissionMode = vi.fn().mockResolvedValue(undefined);
  gen.applyFlagSettings = vi.fn().mockResolvedValue(undefined);
  gen.setMcpServers = vi.fn().mockResolvedValue({ added: [], removed: [], errors: {} });
  gen.supportedCommands = vi.fn().mockImplementation(() => (
    mockSupportedCommandsImplementation
      ? mockSupportedCommandsImplementation()
      : Promise.resolve(mockSupportedCommands)
  ));
  gen.close = vi.fn();
  gen.initializationResult = vi.fn().mockImplementation(async () => mockInitialization ? mockInitialization() : ({
    commands: mockSupportedCommands,
    models: mockSupportedModels,
    agents: [],
    account: {},
    output_style: 'default',
    available_output_styles: mockOutputStyles,
  }));
  gen.getContextUsage = vi.fn().mockImplementation(() => (
    mockContextUsage
      ? Promise.resolve(mockContextUsage)
      : Promise.reject(new Error('Context usage unavailable'))
  ));
  lastResponse = gen;

  return gen;
}

export function receiveInput(query: ScriptedQuery) {
  return ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
    void (async () => {
      for await (const message of prompt) receivedMessages.push(message);
    })();
    return query;
  };
}

export function createInputDrivenQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  script: (nextInput: () => Promise<SDKUserMessage>) => AsyncGenerator<unknown>,
): ScriptedQuery {
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const input = prompt[Symbol.asyncIterator]();
  const nextInput = async () => {
    const next = await input.next();
    if (next.done) throw new Error('Native input closed');
    return next.value;
  };
  const query = (async function* () {
    try {
      yield* script(nextInput);
    } finally {
      resolveFinished();
    }
  })();
  return attachQueryMethods(query, finished);
}

export function createScriptedPersistentQuery(
  turns: Array<Array<unknown | Promise<unknown>>>,
): ScriptedQuery {
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const query = (async function* () {
    try {
      for (const turn of turns) {
        for (const message of turn) {
          const resolved = await message;
          if (resolved !== null) {
            yield resolved;
          }
        }
      }
    } finally {
      resolveFinished();
    }
  })();
  return attachQueryMethods(query, finished);
}

export function createFailingPersistentQuery(
  messages: Array<unknown | Promise<unknown>>,
  error: Error,
): ScriptedQuery {
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const query = (async function* () {
    try {
      for (const message of messages) {
        const resolved = await message;
        if (resolved !== null) {
          yield resolved;
        }
      }
      throw error;
    } finally {
      resolveFinished();
    }
  })();
  return attachQueryMethods(query, finished);
}

export function createPromptDrivenPersistentQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  resolveTurn: (
    promptText: string,
  ) => Array<unknown | Promise<unknown>>,
): ScriptedQuery {
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const query = (async function* () {
    try {
      for await (const message of prompt) {
        for (const event of resolveTurn(getNativePromptText(message))) {
          const resolved = await event;
          if (resolved !== null) {
            yield resolved;
          }
        }
      }
    } finally {
      resolveFinished();
    }
  })();
  return attachQueryMethods(query, finished);
}

export function getNativePromptText(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is { type: 'text'; text: string } => (
      block.type === 'text'
    ))
    .map(block => block.text)
    .join('\n');
}

export type ScriptedQuery = AsyncGenerator<unknown> & {
  interrupt: Mock<Query['interrupt']>;
  setModel: Mock<Query['setModel']>;
  setPermissionMode: Mock<Query['setPermissionMode']>;
  setMcpServers: Mock<Query['setMcpServers']>;
  applyFlagSettings: Mock<Query['applyFlagSettings']>;
  supportedCommands: Mock<Query['supportedCommands']>;
  rewindFiles: Mock<Query['rewindFiles']>;
  finished: Promise<void>;
};

function attachQueryMethods(
  query: AsyncGenerator<unknown>,
  finished: Promise<void>,
): ScriptedQuery {
  return Object.assign(query, {
    interrupt: vi.fn<Query['interrupt']>().mockResolvedValue(undefined),
    setModel: vi.fn<Query['setModel']>().mockResolvedValue(undefined),
    setPermissionMode: vi.fn<Query['setPermissionMode']>().mockResolvedValue(undefined),
    setMcpServers: vi.fn<Query['setMcpServers']>().mockResolvedValue({ added: [], removed: [], errors: {} }),
    applyFlagSettings: vi.fn<Query['applyFlagSettings']>().mockResolvedValue(undefined),
    supportedCommands: vi.fn<Query['supportedCommands']>().mockResolvedValue([]),
    rewindFiles: vi.fn<Query['rewindFiles']>().mockResolvedValue({ canRewind: true, filesChanged: [] }),
    finished,
  });
}

export function createThrowingPersistentQuery(error: Error): ReturnType<
  typeof createScriptedPersistentQuery
> {
  const throwing = (async function* () {
    await Promise.reject(error);
    yield undefined;
  })();
  return attachQueryMethods(throwing, Promise.resolve());
}

export function createIdlePersistentQuery(): ReturnType<
  typeof createScriptedPersistentQuery
> {
  const idle = (async function* () {
    await new Promise<void>(() => undefined);
    yield undefined;
  })();
  return attachQueryMethods(
    idle,
    new Promise<void>(() => undefined),
  );
}
