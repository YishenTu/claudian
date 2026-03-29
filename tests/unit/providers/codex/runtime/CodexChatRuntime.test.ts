import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { PreparedChatTurn } from '@/core/runtime/types';
import type { StreamChunk } from '@/core/types/chat';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockTransportRequest = jest.fn();
const mockTransportNotify = jest.fn();
const mockTransportOnNotification = jest.fn();
const mockTransportOnServerRequest = jest.fn();
const mockTransportDispose = jest.fn();
const mockTransportStart = jest.fn();

jest.mock('@/providers/codex/runtime/CodexRpcTransport', () => ({
  CodexRpcTransport: jest.fn().mockImplementation(() => ({
    request: mockTransportRequest,
    notify: mockTransportNotify,
    onNotification: mockTransportOnNotification,
    onServerRequest: mockTransportOnServerRequest,
    dispose: mockTransportDispose,
    start: mockTransportStart,
  })),
}));

const mockProcessStart = jest.fn();
const mockProcessShutdown = jest.fn().mockResolvedValue(undefined);
const mockProcessIsAlive = jest.fn().mockReturnValue(true);
const mockProcessOnExit = jest.fn();
const mockProcessStdin = { write: jest.fn((_c: any, _e: any, cb: any) => cb?.()) };
const mockProcessStdout = {};
const mockProcessStderr = {};

jest.mock('@/providers/codex/runtime/CodexAppServerProcess', () => ({
  CodexAppServerProcess: jest.fn().mockImplementation(() => ({
    start: mockProcessStart,
    shutdown: mockProcessShutdown,
    isAlive: mockProcessIsAlive,
    onExit: mockProcessOnExit,
    get stdin() { return mockProcessStdin; },
    get stdout() { return mockProcessStdout; },
    get stderr() { return mockProcessStderr; },
  })),
}));

jest.mock('@/utils/path', () => ({
  getVaultPath: jest.fn().mockReturnValue('/test/vault'),
}));

jest.mock('@/utils/env', () => ({
  parseEnvironmentVariables: jest.requireActual('@/utils/env').parseEnvironmentVariables,
  getEnhancedPath: jest.fn().mockReturnValue('/usr/bin:/usr/local/bin'),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { CodexAppServerProcess as MockedProcessClass } from '@/providers/codex/runtime/CodexAppServerProcess';
import { CodexChatRuntime } from '@/providers/codex/runtime/CodexChatRuntime';

type CapturedServerRequestHandler = (requestId: string | number, params: unknown) => Promise<unknown>;

// Notification handlers captured by onNotification
let notificationHandlers: Map<string, (params: unknown) => void>;
let serverRequestHandlers: Map<string, CapturedServerRequestHandler>;

function captureHandlers(): void {
  notificationHandlers = new Map();
  serverRequestHandlers = new Map();

  mockTransportOnNotification.mockImplementation((method: string, handler: any) => {
    notificationHandlers.set(method, handler);
  });

  mockTransportOnServerRequest.mockImplementation((method: string, handler: any) => {
    serverRequestHandlers.set(method, handler);
  });
}

// Emit a notification as if the app-server sent it
function emitNotification(method: string, params: unknown): void {
  const handler = notificationHandlers.get(method);
  if (handler) handler(params);
}

async function emitServerRequest(
  method: string,
  requestId: string | number,
  params: unknown,
): Promise<unknown> {
  const handler = serverRequestHandlers.get(method);
  if (!handler) {
    throw new Error(`No handler registered for ${method}`);
  }

  return handler(requestId, params);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockPlugin(overrides: Record<string, unknown> = {}): any {
  return {
    settings: {
      model: 'gpt-5.4',
      effortLevel: 'medium',
      systemPrompt: '',
      mediaFolder: '',
      allowedExportPaths: [],
      allowExternalAccess: false,
      userName: '',
      ...overrides,
    },
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(
      'OPENAI_API_KEY=test-key\nOPENAI_BASE_URL=https://example.test/v1',
    ),
    getResolvedCodexCliPath: jest.fn().mockReturnValue('/usr/local/bin/codex'),
    app: {
      vault: {
        adapter: { basePath: '/test/vault' },
      },
    },
  };
}

function createTurn(text = 'hello'): PreparedChatTurn {
  return {
    request: { text },
    persistedContent: text,
    prompt: text,
    isCompact: false,
    mcpMentions: new Set(),
  };
}

async function collectChunks(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

// Default thread/start response
function threadStartResponse(threadId = 'thread-001') {
  return {
    thread: {
      id: threadId,
      path: `/tmp/sessions/${threadId}.jsonl`,
      preview: '',
      ephemeral: false,
      status: { type: 'idle' },
      turns: [],
      cwd: '/test/vault',
      cliVersion: '0.117.0',
      modelProvider: 'openai_http',
      source: 'vscode',
      createdAt: 0,
      updatedAt: 0,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
    },
    model: 'gpt-5.4',
    modelProvider: 'openai_http',
    serviceTier: null,
    cwd: '/test/vault',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite' },
    reasoningEffort: 'medium',
  };
}

function turnStartResponse(turnId = 'turn-001') {
  return {
    turn: { id: turnId, items: [], status: 'inProgress', error: null },
  };
}

// Setup default transport.request mock: initialize → thread/start → turn/start
function setupDefaultRequestMock(
  threadId = 'thread-001',
  turnId = 'turn-001',
  options: { isResume?: boolean } = {},
): void {
  mockTransportRequest.mockImplementation(async (method: string) => {
    switch (method) {
      case 'initialize':
        return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
      case 'thread/start':
        return threadStartResponse(threadId);
      case 'thread/resume':
        return threadStartResponse(threadId);
      case 'turn/start':
        // After turn/start, schedule notifications
        setTimeout(() => {
          emitNotification('item/agentMessage/delta', {
            threadId, turnId, itemId: 'msg1', delta: 'Hello!',
          });
          emitNotification('thread/tokenUsage/updated', {
            threadId, turnId,
            tokenUsage: {
              total: { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 100, outputTokens: 100, reasoningOutputTokens: 50 },
              last: { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 100, outputTokens: 100, reasoningOutputTokens: 50 },
              modelContextWindow: 200000,
            },
          });
          emitNotification('turn/completed', {
            threadId, turn: { id: turnId, items: [], status: 'completed', error: null },
          });
        }, 0);
        return turnStartResponse(turnId);
      case 'turn/interrupt':
        return {};
      default:
        throw new Error(`Unexpected request: ${method}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexChatRuntime', () => {
  let runtime: CodexChatRuntime;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessIsAlive.mockReturnValue(true);
    captureHandlers();
    setupDefaultRequestMock();
    runtime = new CodexChatRuntime(createMockPlugin());
  });

  afterEach(() => {
    runtime.cleanup();
  });

  it('should have codex as providerId', () => {
    expect(runtime.providerId).toBe('codex');
  });

  it('should return codex capabilities', () => {
    const caps = runtime.getCapabilities();
    expect(caps.providerId).toBe('codex');
    expect(caps.supportsRewind).toBe(false);
    expect(caps.supportsFork).toBe(false);
    expect(caps.supportsPlanMode).toBe(false);
  });

  it('should return empty commands', async () => {
    expect(await runtime.getSupportedCommands()).toEqual([]);
  });

  it('should return canRewind: false', async () => {
    expect((await runtime.rewind('u1', 'a1')).canRewind).toBe(false);
  });

  describe('ensureReady - app-server lifecycle', () => {
    it('spawns the app-server process', async () => {
      await runtime.ensureReady();

      expect(MockedProcessClass).toHaveBeenCalledWith(
        '/usr/local/bin/codex',
        '/test/vault',
        expect.objectContaining({
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'https://example.test/v1',
        }),
      );
      expect(mockProcessStart).toHaveBeenCalled();
    });

    it('sends initialize and initialized', async () => {
      await runtime.ensureReady();

      expect(mockTransportRequest).toHaveBeenCalledWith(
        'initialize',
        expect.objectContaining({
          clientInfo: { name: 'claudian', version: '1.0.0' },
        }),
      );
      expect(mockTransportNotify).toHaveBeenCalledWith('initialized');
    });

    it('does not rebuild when config has not changed', async () => {
      await runtime.ensureReady();
      const firstCallCount = (MockedProcessClass as jest.Mock).mock.calls.length;

      await runtime.ensureReady();
      expect((MockedProcessClass as jest.Mock).mock.calls.length).toBe(firstCallCount);
    });

    it('rebuilds when the system prompt changes', async () => {
      await runtime.ensureReady();

      const plugin = (runtime as any).plugin;
      plugin.settings.systemPrompt = 'New instructions';

      const rebuilt = await runtime.ensureReady();
      expect(rebuilt).toBe(true);
      // Shutdown was called on old process
      expect(mockTransportDispose).toHaveBeenCalled();
      expect(mockProcessShutdown).toHaveBeenCalled();
    });

    it('rebuilds when force is true', async () => {
      await runtime.ensureReady();
      const rebuilt = await runtime.ensureReady({ force: true });
      expect(rebuilt).toBe(true);
    });

    it('rebuilds when the existing app-server process is no longer alive', async () => {
      await runtime.ensureReady();
      const firstCallCount = (MockedProcessClass as jest.Mock).mock.calls.length;

      mockProcessIsAlive.mockReturnValue(false);

      const rebuilt = await runtime.ensureReady();

      expect(rebuilt).toBe(true);
      expect((MockedProcessClass as jest.Mock).mock.calls.length).toBe(firstCallCount + 1);
      expect(mockTransportDispose).toHaveBeenCalled();
      expect(mockProcessShutdown).toHaveBeenCalled();
    });
  });

  describe('query - new thread', () => {
    it('sends thread/start and streams text', async () => {
      const chunks = await collectChunks(runtime.query(createTurn('hi')));

      // Verify thread/start was called
      expect(mockTransportRequest).toHaveBeenCalledWith(
        'thread/start',
        expect.objectContaining({
          model: 'gpt-5.4',
          cwd: '/test/vault',
          persistExtendedHistory: true,
          experimentalRawEvents: false,
          baseInstructions: expect.any(String),
        }),
      );

      // Verify text chunk
      expect(chunks).toContainEqual({ type: 'text', content: 'Hello!' });
      expect(chunks).toContainEqual({ type: 'done' });
    });

    it('passes baseInstructions (no temp file)', async () => {
      const plugin = createMockPlugin({ systemPrompt: 'Be helpful.' });
      const rt = new CodexChatRuntime(plugin);

      await collectChunks(rt.query(createTurn()));

      const threadStartCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'thread/start',
      );
      expect(threadStartCall).toBeDefined();
      expect(threadStartCall[1].baseInstructions).toContain('Be helpful.');

      rt.cleanup();
    });

    it('captures thread ID and session file path', async () => {
      await collectChunks(runtime.query(createTurn()));

      expect(runtime.getSessionId()).toBe('thread-001');

      const result = runtime.buildSessionUpdates({ conversation: null, sessionInvalidated: false });
      expect(result.updates.sessionId).toBe('thread-001');
      expect((result.updates.providerState as any).threadId).toBe('thread-001');
      expect((result.updates.providerState as any).sessionFilePath).toBe('/tmp/sessions/thread-001.jsonl');
    });
  });

  describe('query - thread resume', () => {
    it('sends thread/resume when a threadId exists', async () => {
      runtime.syncConversationState({
        sessionId: 'thread-existing',
        providerState: { threadId: 'thread-existing', sessionFilePath: '/tmp/existing.jsonl' },
      });

      setupDefaultRequestMock('thread-existing');
      captureHandlers();

      await collectChunks(runtime.query(createTurn()));

      const resumeCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'thread/resume',
      );
      expect(resumeCall).toBeDefined();
      expect(resumeCall[1].threadId).toBe('thread-existing');
      expect(resumeCall[1].baseInstructions).toBeDefined();

      const startCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'thread/start',
      );
      expect(startCall).toBeUndefined();
    });

    it('skips resume when thread is already loaded in this daemon', async () => {
      // First query starts a new thread
      await collectChunks(runtime.query(createTurn()));
      expect(runtime.getSessionId()).toBe('thread-001');

      // Clear mocks for second query
      mockTransportRequest.mockClear();
      captureHandlers();
      setupDefaultRequestMock('thread-001');

      // Second query on same thread should skip both start and resume
      await collectChunks(runtime.query(createTurn('second')));

      const startCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'thread/start',
      );
      const resumeCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'thread/resume',
      );
      expect(startCall).toBeUndefined();
      expect(resumeCall).toBeUndefined();
    });
  });

  describe('query - streaming', () => {
    it('yields usage chunk from token usage notification', async () => {
      const chunks = await collectChunks(runtime.query(createTurn()));

      const usageChunk = chunks.find(c => c.type === 'usage');
      expect(usageChunk).toBeDefined();
      expect(usageChunk).toMatchObject({
        type: 'usage',
        usage: {
          inputTokens: 900,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
        },
      });
    });

    it('yields tool_use and tool_result from item notifications', async () => {
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
        if (method === 'thread/start') return threadStartResponse('thread-tools');
        if (method === 'turn/start') {
          setTimeout(() => {
            emitNotification('item/started', {
              item: {
                type: 'commandExecution',
                id: 'call_1',
                command: 'echo test',
                cwd: '/test/vault',
                processId: '1',
                source: 'unifiedExecStartup',
                status: 'inProgress',
                commandActions: [{ type: 'unknown', command: 'echo test' }],
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
              },
              threadId: 'thread-tools',
              turnId: 'turn-tools',
            });
            emitNotification('item/completed', {
              item: {
                type: 'commandExecution',
                id: 'call_1',
                command: 'echo test',
                cwd: '/test/vault',
                processId: '1',
                source: 'unifiedExecStartup',
                status: 'completed',
                commandActions: [],
                aggregatedOutput: 'test\n',
                exitCode: 0,
                durationMs: 10,
              },
              threadId: 'thread-tools',
              turnId: 'turn-tools',
            });
            emitNotification('turn/completed', {
              threadId: 'thread-tools',
              turn: { id: 'turn-tools', items: [], status: 'completed', error: null },
            });
          }, 0);
          return turnStartResponse('turn-tools');
        }
        return {};
      });

      const chunks = await collectChunks(runtime.query(createTurn()));

      expect(chunks).toContainEqual(expect.objectContaining({
        type: 'tool_use',
        id: 'call_1',
        name: 'Bash',
      }));
      expect(chunks).toContainEqual(expect.objectContaining({
        type: 'tool_result',
        id: 'call_1',
        content: 'test\n',
        isError: false,
      }));
    });

    it('prefers session-tail tool chunks when a Codex session file is available', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tail-runtime-'));
      const sessionFilePath = path.join(tmpDir, 'thread-tail.jsonl');
      fs.writeFileSync(sessionFilePath, '');

      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
        }
        if (method === 'thread/start') {
          const response = threadStartResponse('thread-tail');
          response.thread.path = sessionFilePath;
          return response;
        }
        if (method === 'turn/start') {
          setTimeout(() => {
            fs.appendFileSync(
              sessionFilePath,
              [
                JSON.stringify({
                  timestamp: '2026-03-28T10:00:01.000Z',
                  type: 'response_item',
                  payload: {
                    type: 'function_call',
                    name: 'exec_command',
                    arguments: '{"command":"cat src/main.ts"}',
                    call_id: 'call_tail_1',
                  },
                }),
                JSON.stringify({
                  timestamp: '2026-03-28T10:00:02.000Z',
                  type: 'response_item',
                  payload: {
                    type: 'function_call_output',
                    call_id: 'call_tail_1',
                    output: 'Exit code: 0\nOutput:\nimport x from "./main";',
                  },
                }),
              ].join('\n') + '\n',
            );

            emitNotification('item/started', {
              item: {
                type: 'commandExecution',
                id: 'call_wrong_1',
                command: 'echo wrong',
                cwd: '/test/vault',
                processId: '1',
                source: 'unifiedExecStartup',
                status: 'inProgress',
                commandActions: [{ type: 'unknown', command: 'echo wrong' }],
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
              },
              threadId: 'thread-tail',
              turnId: 'turn-tail',
            });
            emitNotification('item/completed', {
              item: {
                type: 'commandExecution',
                id: 'call_wrong_1',
                command: 'echo wrong',
                cwd: '/test/vault',
                processId: '1',
                source: 'unifiedExecStartup',
                status: 'completed',
                commandActions: [],
                aggregatedOutput: 'wrong\n',
                exitCode: 0,
                durationMs: 10,
              },
              threadId: 'thread-tail',
              turnId: 'turn-tail',
            });
            emitNotification('turn/completed', {
              threadId: 'thread-tail',
              turn: { id: 'turn-tail', items: [], status: 'completed', error: null },
            });
          }, 0);
          return turnStartResponse('turn-tail');
        }
        return {};
      });

      try {
        const chunks = await collectChunks(runtime.query(createTurn()));

        expect(chunks).toContainEqual(expect.objectContaining({
          type: 'tool_use',
          id: 'call_tail_1',
          name: 'Bash',
          input: { command: 'cat src/main.ts' },
        }));
        expect(chunks).toContainEqual(expect.objectContaining({
          type: 'tool_result',
          id: 'call_tail_1',
          content: 'import x from "./main";',
          isError: false,
        }));
        expect(chunks).not.toContainEqual(expect.objectContaining({ id: 'call_wrong_1' }));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 10000);

    it('emits error then done on failed turn', async () => {
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
        if (method === 'thread/start') return threadStartResponse('thread-fail');
        if (method === 'turn/start') {
          setTimeout(() => {
            emitNotification('turn/completed', {
              threadId: 'thread-fail',
              turn: {
                id: 'turn-fail',
                items: [],
                status: 'failed',
                error: { message: 'Model error', codexErrorInfo: 'other', additionalDetails: null },
              },
            });
          }, 0);
          return turnStartResponse('turn-fail');
        }
        return {};
      });

      const chunks = await collectChunks(runtime.query(createTurn()));

      expect(chunks).toContainEqual({ type: 'error', content: 'Model error' });
      expect(chunks).toContainEqual({ type: 'done' });
    });

    it('ignores stale turn completion from a canceled previous turn', async () => {
      let turnStartCount = 0;

      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
        }

        if (method === 'thread/start') {
          return threadStartResponse('thread-stale');
        }

        if (method === 'turn/start') {
          turnStartCount += 1;

          if (turnStartCount === 1) {
            return turnStartResponse('turn-old');
          }

          setTimeout(() => {
            emitNotification('turn/completed', {
              threadId: 'thread-stale',
              turn: { id: 'turn-old', items: [], status: 'completed', error: null },
            });
            emitNotification('item/agentMessage/delta', {
              threadId: 'thread-stale',
              turnId: 'turn-new',
              itemId: 'msg-new',
              delta: 'Fresh response',
            });
            emitNotification('turn/completed', {
              threadId: 'thread-stale',
              turn: { id: 'turn-new', items: [], status: 'completed', error: null },
            });
          }, 0);

          return turnStartResponse('turn-new');
        }

        if (method === 'turn/interrupt') {
          return {};
        }

        return {};
      });

      const firstGen = runtime.query(createTurn('first'));
      const firstResult = firstGen.next();
      await new Promise(r => setTimeout(r, 25));

      runtime.cancel();

      const first = await firstResult;
      const interruptedChunks: StreamChunk[] = [];
      if (!first.done && first.value) interruptedChunks.push(first.value);
      for await (const chunk of firstGen) interruptedChunks.push(chunk);

      expect(interruptedChunks).toContainEqual({ type: 'done' });

      const secondChunks = await collectChunks(runtime.query(createTurn('second')));

      expect(secondChunks).toContainEqual({ type: 'text', content: 'Fresh response' });
      expect(secondChunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
    });
  });

  describe('cancel', () => {
    it('sends turn/interrupt with current threadId and turnId', async () => {
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
        if (method === 'thread/start') return threadStartResponse('thread-cancel');
        if (method === 'turn/start') return turnStartResponse('turn-cancel');
        if (method === 'turn/interrupt') return {};
        return {};
      });

      const gen = runtime.query(createTurn());
      // Kick the generator so it enters the chunk-waiting loop
      const firstResult = gen.next();
      await new Promise(r => setTimeout(r, 50));

      runtime.cancel();

      // Collect all chunks
      const chunks: StreamChunk[] = [];
      const first = await firstResult;
      if (!first.done && first.value) chunks.push(first.value);
      for await (const chunk of gen) chunks.push(chunk);

      expect(mockTransportRequest).toHaveBeenCalledWith(
        'turn/interrupt',
        { threadId: 'thread-cancel', turnId: 'turn-cancel' },
      );
      expect(chunks).toContainEqual({ type: 'done' });
    });
  });

  describe('session management', () => {
    it('clears provider state when session is invalidated', () => {
      runtime.syncConversationState({
        sessionId: 'thread_inv',
        providerState: { threadId: 'thread_inv', sessionFilePath: '/tmp/inv.jsonl' },
      });

      const result = runtime.buildSessionUpdates({
        conversation: {} as any,
        sessionInvalidated: true,
      });

      expect(result.updates.sessionId).toBeNull();
      expect(result.updates.providerState).toBeUndefined();
    });

    it('round-trips an existing session file path', () => {
      runtime.syncConversationState({
        sessionId: 'thread_rt',
        providerState: { threadId: 'thread_rt', sessionFilePath: '/tmp/rt.jsonl' },
      });

      const result = runtime.buildSessionUpdates({
        conversation: null,
        sessionInvalidated: false,
      });

      expect((result.updates.providerState as any).sessionFilePath).toBe('/tmp/rt.jsonl');
    });
  });

  describe('query - image support', () => {
    it('converts image attachments to localImage inputs', async () => {
      const turn = createTurn('describe this');
      turn.request.images = [
        { id: 'img1', name: 'test.png', data: Buffer.from('fake-png').toString('base64'), mediaType: 'image/png', size: 100, source: 'file' as const },
      ];

      await collectChunks(runtime.query(turn));

      const turnStartCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'turn/start',
      );
      expect(turnStartCall).toBeDefined();
      const input = turnStartCall[1].input;
      expect(input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'localImage' }),
          expect.objectContaining({ type: 'text', text: 'describe this' }),
        ]),
      );
    });

    it('cleans up temporary image files after the turn completes', async () => {
      const turn = createTurn('describe this');
      turn.request.images = [
        { id: 'img1', name: 'test.png', data: Buffer.from('fake-png').toString('base64'), mediaType: 'image/png', size: 100, source: 'file' as const },
      ];

      await collectChunks(runtime.query(turn));

      const turnStartCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'turn/start',
      );
      const imageInput = turnStartCall?.[1]?.input?.find((item: Record<string, unknown>) => item.type === 'localImage');

      expect(imageInput).toBeDefined();
      expect(fs.existsSync(imageInput.path as string)).toBe(false);
      expect(fs.existsSync(path.dirname(imageInput.path as string))).toBe(false);
    });
  });

  describe('serverRequest/resolved lifecycle', () => {
    it('subscribes to serverRequest/resolved notifications', async () => {
      const gen = runtime.query(createTurn());
      // Kick the generator to start execution
      gen.next();
      await new Promise(r => setTimeout(r, 50));

      expect(notificationHandlers.has('serverRequest/resolved')).toBe(true);

      // Clean up generator
      runtime.cancel();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of gen) { /* drain */ }
    });

    it('only dismisses approval UI when serverRequest/resolved matches the active request and thread', async () => {
      const dismisser = jest.fn();
      runtime.setApprovalDismisser(dismisser);
      runtime.setApprovalCallback(jest.fn().mockImplementation(async () => new Promise(() => {})));

      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
        if (method === 'thread/start') return threadStartResponse('thread-dismiss');
        if (method === 'turn/start') {
          setTimeout(() => {
            void emitServerRequest('item/commandExecution/requestApproval', 'req-live', {
              threadId: 'thread-dismiss',
              turnId: 'turn-dismiss',
              itemId: 'cmd-1',
              command: 'echo test',
              cwd: '/test/vault',
            });
            emitNotification('serverRequest/resolved', {
              threadId: 'thread-other',
              requestId: 'req-live',
            });
            emitNotification('serverRequest/resolved', {
              threadId: 'thread-dismiss',
              requestId: 'req-stale',
            });
            emitNotification('turn/completed', {
              threadId: 'thread-dismiss',
              turn: { id: 'turn-dismiss', items: [], status: 'completed', error: null },
            });
          }, 0);
          return turnStartResponse('turn-dismiss');
        }
        return {};
      });

      await collectChunks(runtime.query(createTurn()));

      expect(dismisser).not.toHaveBeenCalled();

      emitNotification('serverRequest/resolved', {
        threadId: 'thread-dismiss',
        requestId: 'req-live',
      });

      expect(dismisser).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancel dismisses approval UI', () => {
    it('calls approvalDismisser on cancel', async () => {
      const dismisser = jest.fn();
      runtime.setApprovalDismisser(dismisser);

      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
        if (method === 'thread/start') return threadStartResponse('thread-cancel-dismiss');
        if (method === 'turn/start') return turnStartResponse('turn-cancel-dismiss');
        if (method === 'turn/interrupt') return {};
        return {};
      });

      const gen = runtime.query(createTurn());
      const firstResult = gen.next();
      await new Promise(r => setTimeout(r, 50));

      runtime.cancel();

      const chunks: StreamChunk[] = [];
      const first = await firstResult;
      if (!first.done && first.value) chunks.push(first.value);
      for await (const chunk of gen) chunks.push(chunk);

      expect(dismisser).toHaveBeenCalled();
    });
  });

  describe('thread/resume reasserts current settings', () => {
    it('sends approvalPolicy and sandbox on thread/resume', async () => {
      const plugin = createMockPlugin({ permissionMode: 'yolo' });
      const rt = new CodexChatRuntime(plugin);

      rt.syncConversationState({
        sessionId: 'thread-resume-settings',
        providerState: { threadId: 'thread-resume-settings', sessionFilePath: '/tmp/resume.jsonl' },
      });

      setupDefaultRequestMock('thread-resume-settings');
      captureHandlers();

      await collectChunks(rt.query(createTurn()));

      const resumeCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'thread/resume',
      );
      expect(resumeCall).toBeDefined();
      expect(resumeCall[1].approvalPolicy).toBe('never');
      expect(resumeCall[1].sandbox).toBe('danger-full-access');

      rt.cleanup();
    });

    it('sends model on thread/resume', async () => {
      const plugin = createMockPlugin({ model: 'gpt-5.4-mini' });
      const rt = new CodexChatRuntime(plugin);

      rt.syncConversationState({
        sessionId: 'thread-resume-model',
        providerState: { threadId: 'thread-resume-model' },
      });

      setupDefaultRequestMock('thread-resume-model');
      captureHandlers();

      await collectChunks(rt.query(createTurn()));

      const resumeCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'thread/resume',
      );
      expect(resumeCall).toBeDefined();
      expect(resumeCall[1].model).toBe('gpt-5.4-mini');

      rt.cleanup();
    });

    it('reasserts approvalPolicy and sandboxPolicy on turn/start for already-loaded threads', async () => {
      const plugin = createMockPlugin({ permissionMode: 'normal' });
      const rt = new CodexChatRuntime(plugin);

      await collectChunks(rt.query(createTurn('first')));

      mockTransportRequest.mockClear();
      captureHandlers();
      setupDefaultRequestMock('thread-001', 'turn-002');

      plugin.settings.permissionMode = 'yolo';
      await collectChunks(rt.query(createTurn('second')));

      const turnStartCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'turn/start',
      );
      expect(turnStartCall).toBeDefined();
      expect(turnStartCall[1].approvalPolicy).toBe('never');
      expect(turnStartCall[1].sandboxPolicy).toEqual({ type: 'dangerFullAccess' });

      rt.cleanup();
    });
  });

  describe('query - permission modes', () => {
    it('uses danger-full-access for yolo mode', async () => {
      const plugin = createMockPlugin({ permissionMode: 'yolo' });
      const yoloRuntime = new CodexChatRuntime(plugin);

      await collectChunks(yoloRuntime.query(createTurn()));

      const threadStartCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'thread/start',
      );
      expect(threadStartCall[1].sandbox).toBe('danger-full-access');
      expect(threadStartCall[1].approvalPolicy).toBe('never');

      yoloRuntime.cleanup();
    });

    it('uses workspace-write with on-request for normal mode', async () => {
      const plugin = createMockPlugin({ permissionMode: 'normal' });
      const safeRuntime = new CodexChatRuntime(plugin);

      await collectChunks(safeRuntime.query(createTurn()));

      const threadStartCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'thread/start',
      );
      expect(threadStartCall[1].sandbox).toBe('workspace-write');
      expect(threadStartCall[1].approvalPolicy).toBe('on-request');

      safeRuntime.cleanup();
    });

    it('falls back to normal mode for unrecognized permissionMode', async () => {
      const plugin = createMockPlugin({ permissionMode: 'plan' });
      const rt = new CodexChatRuntime(plugin);

      await collectChunks(rt.query(createTurn()));

      const threadStartCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'thread/start',
      );
      expect(threadStartCall[1].sandbox).toBe('workspace-write');
      expect(threadStartCall[1].approvalPolicy).toBe('on-request');

      rt.cleanup();
    });

    it('always sends baseline sandboxPolicy even without external context', async () => {
      const plugin = createMockPlugin({ permissionMode: 'normal' });
      const rt = new CodexChatRuntime(plugin);

      await collectChunks(rt.query(createTurn()));

      const turnStartCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'turn/start',
      );
      expect(turnStartCall[1].sandboxPolicy).toBeDefined();
      expect(turnStartCall[1].sandboxPolicy.type).toBe('workspaceWrite');
      expect(turnStartCall[1].sandboxPolicy.writableRoots).toContain('/test/vault');

      rt.cleanup();
    });

    it('sends explicit dangerFullAccess sandboxPolicy in yolo mode', async () => {
      const plugin = createMockPlugin({ permissionMode: 'yolo' });
      const rt = new CodexChatRuntime(plugin);

      await collectChunks(rt.query(createTurn()));

      const turnStartCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'turn/start',
      );
      expect(turnStartCall[1].sandboxPolicy).toEqual({ type: 'dangerFullAccess' });

      rt.cleanup();
    });

    it('sends sandboxPolicy with external context writable roots in normal mode', async () => {
      const turn = createTurn('inspect both locations');
      turn.request.externalContextPaths = ['/external/a', '/external/b'];

      await collectChunks(runtime.query(turn));

      const turnStartCall = mockTransportRequest.mock.calls.find(
        (call: any[]) => call[0] === 'turn/start',
      );

      expect(turnStartCall[1].sandboxPolicy).toMatchObject({
        type: 'workspaceWrite',
        writableRoots: expect.arrayContaining([
          '/test/vault',
          '/external/a',
          '/external/b',
        ]),
        readOnlyAccess: { type: 'fullAccess' },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      });
    });
  });
});
