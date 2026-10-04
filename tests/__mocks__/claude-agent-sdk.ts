// Mock for @anthropic-ai/claude-agent-sdk

export interface HookCallbackMatcher {
  matcher?: string;
  hooks: Array<(hookInput: any, toolUseID: string, options: any) => Promise<{ continue: boolean; hookSpecificOutput?: any }>>;
}

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: {
    [envVar: string]: string | undefined;
  };
  signal: AbortSignal;
}

export interface SpawnedProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream | null;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: NodeJS.Signals) => void;
  on: (event: 'exit' | 'error', listener: (...args: any[]) => void) => void;
  once: (event: 'exit' | 'error', listener: (...args: any[]) => void) => void;
  off: (event: 'exit' | 'error', listener: (...args: any[]) => void) => void;
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

let customMockMessages: any[] | null = null;
let appendResultMessage = true;
let lastOptions: Options | undefined;
let mockSupportedCommands: Array<{ name: string; description: string; argumentHint?: string }> = [];
let mockSupportedCommandsImplementation: (() => Promise<Array<{
  name: string;
  description: string;
  argumentHint?: string;
}>>) | null = null;
let mockSupportedModels: ModelInfo[] = [];
let mockOutputStyles: string[] = [];
let mockContextUsage: { rawMaxTokens: number } | null = null;
let lastResponse: (AsyncGenerator<any> & {
  interrupt: jest.Mock;
  setModel: jest.Mock;
  setMaxThinkingTokens: jest.Mock;
  setPermissionMode: jest.Mock;
  applyFlagSettings: jest.Mock;
  setMcpServers: jest.Mock;
  supportedCommands: jest.Mock;
  initializationResult: jest.Mock;
  getContextUsage: jest.Mock;
}) | null = null;

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
  mockSupportedCommands = [];
  mockSupportedCommandsImplementation = null;
  mockSupportedModels = [];
  mockOutputStyles = [];
  mockContextUsage = null;
  lastResponse = null;
  queryCallCount = 0;
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

export function getLastOptions(): Options | undefined {
  return lastOptions;
}

export function getLastResponse(): typeof lastResponse {
  return lastResponse;
}

// Mock query function that returns an async generator
function isAsyncIterable(value: any): value is AsyncIterable<any> {
  return !!value && typeof value[Symbol.asyncIterator] === 'function';
}

function getMessagesForPrompt(): any[] {
  const baseMessages = customMockMessages || mockMessages;
  const messages = [...baseMessages];
  if (appendResultMessage && !messages.some((msg) => msg.type === 'result')) {
    messages.push({ type: 'result', subtype: 'success' });
  }
  return messages;
}

// Pending entries act as barriers; one that resolves to null emits nothing.
async function* emitMessages(messages: any[]) {
  for (const pendingMessage of messages) {
    const message = await pendingMessage;
    if (message != null) yield message;
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
        yield* emitMessages(messages);
      }
      return;
    }

    const messages = getMessagesForPrompt();
    yield* emitMessages(messages);
  };

  const gen = generator() as AsyncGenerator<any> & {
    interrupt: jest.Mock;
    setModel: jest.Mock;
    setMaxThinkingTokens: jest.Mock;
    setPermissionMode: jest.Mock;
    applyFlagSettings: jest.Mock;
    setMcpServers: jest.Mock;
    supportedCommands: jest.Mock;
    initializationResult: jest.Mock;
    getContextUsage: jest.Mock;
  };
  gen.interrupt = jest.fn().mockResolvedValue(undefined);
  // Dynamic update methods for persistent queries
  gen.setModel = jest.fn().mockResolvedValue(undefined);
  gen.setMaxThinkingTokens = jest.fn().mockResolvedValue(undefined);
  gen.setPermissionMode = jest.fn().mockResolvedValue(undefined);
  gen.applyFlagSettings = jest.fn().mockResolvedValue(undefined);
  gen.setMcpServers = jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} });
  gen.supportedCommands = jest.fn().mockImplementation(() => (
    mockSupportedCommandsImplementation
      ? mockSupportedCommandsImplementation()
      : Promise.resolve(mockSupportedCommands)
  ));
  gen.initializationResult = jest.fn().mockImplementation(async () => ({
    commands: mockSupportedCommands,
    models: mockSupportedModels,
    agents: [],
    account: {},
    output_style: 'default',
    available_output_styles: mockOutputStyles,
  }));
  gen.getContextUsage = jest.fn().mockImplementation(() => (
    mockContextUsage
      ? Promise.resolve(mockContextUsage)
      : Promise.reject(new Error('Context usage unavailable'))
  ));
  lastResponse = gen;

  return gen;
}
