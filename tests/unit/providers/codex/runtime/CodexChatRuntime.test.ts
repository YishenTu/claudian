import '@/providers';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { PreparedChatTurn } from '@/core/runtime/types';
import type { StreamChunk } from '@/core/types/chat';
import { CODEX_SPARK_MODEL, DEFAULT_CODEX_PRIMARY_MODEL } from '@/providers/codex/types/models';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockTransportRequest = jest.fn();
const mockTransportNotify = jest.fn();
const mockTransportOnNotification = jest.fn();
const mockTransportOnServerRequest = jest.fn();
const mockTransportDispose = jest.fn();
const mockTransportStart = jest.fn();
const mockResolveLaunchSpec = jest.fn();

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
  ...jest.requireActual('@/utils/env'),
  getEnhancedPath: jest.fn().mockReturnValue('/usr/bin:/usr/local/bin'),
}));

jest.mock('@/providers/codex/runtime/codexAppServerSupport', () => {
  const actual = jest.requireActual('@/providers/codex/runtime/codexAppServerSupport');
  return {
    ...actual,
    resolveCodexAppServerLaunchSpec: (...args: unknown[]) => mockResolveLaunchSpec(...args),
  };
});

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
      model: DEFAULT_CODEX_PRIMARY_MODEL,
      effortLevel: 'medium',
      systemPrompt: '',
      mediaFolder: '',
      userName: '',
      ...overrides,
    },
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(
      'OPENAI_API_KEY=test-key\nOPENAI_BASE_URL=https://example.test/v1',
    ),
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/usr/local/bin/codex'),
    app: {
      vault: {
        adapter: { basePath: '/test/vault' },
      },
    },
  };
}

function createTurn(text = 'hello', overrides: Partial<PreparedChatTurn> = {}): PreparedChatTurn {
  return {
    request: { text },
    persistedContent: text,
    prompt: text,
    isCompact: false,
    mcpMentions: new Set(),
    ...overrides,
  };
}

function createCompactTurn(): PreparedChatTurn {
  return createTurn('/compact', { isCompact: true });
}

function createWslLaunchSpec(overrides: Record<string, unknown> = {}) {
  return {
    target: {
      method: 'wsl',
      platformFamily: 'unix',
      platformOs: 'linux',
      distroName: 'Ubuntu',
    },
    command: 'wsl.exe',
    args: ['--distribution', 'Ubuntu', '--cd', '/mnt/c/vault', 'codex', 'app-server', '--listen', 'stdio://'],
    spawnCwd: 'C:\\vault',
    targetCwd: '/mnt/c/vault',
    env: {
      OPENAI_API_KEY: 'test-key',
    },
    pathMapper: {
      target: {
        method: 'wsl',
        platformFamily: 'unix',
        platformOs: 'linux',
        distroName: 'Ubuntu',
      },
      toTargetPath: jest.fn((value: string) => {
        if (!value) {
          return null;
        }
        if (value.startsWith('/home/') || value.startsWith('/mnt/')) {
          return null;
        }
        if (value.startsWith('/tmp/')) {
          return value.replace('/tmp/', '/mnt/c/tmp/');
        }
        if (value.startsWith('/external/')) {
          return value.replace('/external/', '/mnt/d/external/');
        }
        if (value.startsWith('\\\\wsl$\\Ubuntu\\')) {
          return `/${value.slice('\\\\wsl$\\Ubuntu\\'.length).replace(/\\/g, '/')}`;
        }
        return `/mnt/c/${value.replace(/^\/+/, '').replace(/\\/g, '/')}`;
      }),
      toHostPath: jest.fn((value: string) => {
        if (value.startsWith('/home/user/.codex/sessions/')) {
          return value.replace('/home/user/.codex/sessions/', '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\').replace(/\//g, '\\');
        }
        if (value === '/home/user/.codex/sessions') {
          return '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions';
        }
        if (value === '/home/user/.codex') {
          return '\\\\wsl$\\Ubuntu\\home\\user\\.codex';
        }
        return value;
      }),
      mapTargetPathList: jest.fn((values: string[]) => values.map(value => {
        if (value.startsWith('/external/')) {
          return value.replace('/external/', '/mnt/d/external/');
        }
        return value;
      })),
      canRepresentHostPath: jest.fn(() => true),
    },
    ...overrides,
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
      turns: [] as Array<{ id: string; items: unknown[]; status: string; error: null }>,
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
    model: DEFAULT_CODEX_PRIMARY_MODEL,
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

// Find a specific RPC method call from transport request mock
function findCall(method: string) {
  return mockTransportRequest.mock.calls.find((c: any[]) => c[0] === method) as any;
}

// Build a request handler that returns the initialize response for all methods,
// with overrides for specific methods. Every handler gets the initialize case for free.
function buildRequestHandler(
  handlers: Record<string, (...args: any[]) => any>,
): (method: string, ...args: any[]) => Promise<any> {
  const initResponse = { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
  return async (method: string, ...args: any[]) => {
    if (method === 'initialize') return initResponse;
    const handler = handlers[method];
    if (handler) return handler(...args);
    return {};
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexChatRuntime', () => {
  let runtime: CodexChatRuntime;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessIsAlive.mockReturnValue(true);
    mockResolveLaunchSpec.mockImplementation((plugin: any) => ({
      target: {
        method: 'host-native',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
      command: plugin.getResolvedProviderCliPath('codex') ?? 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      spawnCwd: '/test/vault',
      targetCwd: '/test/vault',
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: 'https://example.test/v1',
        PATH: '/usr/bin:/usr/local/bin',
      },
      pathMapper: {
        target: {
          method: 'host-native',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
        toTargetPath: jest.fn((value: string) => value),
        toHostPath: jest.fn((value: string) => value),
        mapTargetPathList: jest.fn((values: string[]) => values),
        canRepresentHostPath: jest.fn(() => true),
      },
    }));
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
    expect(caps.supportsFork).toBe(true);
    expect(caps.supportsPlanMode).toBe(true);
    expect(caps.supportsInstructionMode).toBe(true);
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

      expect(MockedProcessClass).toHaveBeenCalledWith(expect.objectContaining({
        command: '/usr/local/bin/codex',
        spawnCwd: '/test/vault',
        targetCwd: '/test/vault',
        env: expect.objectContaining({
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'https://example.test/v1',
        }),
      }));
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
          model: DEFAULT_CODEX_PRIMARY_MODEL,
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

    it('handles host-native initialize responses that omit codexHome', async () => {
      mockTransportRequest.mockImplementation(async (method: string) => {
        switch (method) {
          case 'initialize':
            return { userAgent: 'test/0.1', platformFamily: 'unix', platformOs: 'macos' };
          case 'thread/start':
            return threadStartResponse('thread-no-home');
          case 'turn/start':
            setTimeout(() => {
              emitNotification('item/agentMessage/delta', {
                threadId: 'thread-no-home',
                turnId: 'turn-no-home',
                itemId: 'msg1',
                delta: 'Hello!',
              });
              emitNotification('turn/completed', {
                threadId: 'thread-no-home',
                turn: { id: 'turn-no-home', items: [], status: 'completed', error: null },
              });
            }, 0);
            return turnStartResponse('turn-no-home');
          case 'turn/interrupt':
            return {};
          default:
            throw new Error(`Unexpected request: ${method}`);
        }
      });

      const chunks = await collectChunks(runtime.query(createTurn('hi')));

      expect(chunks).toContainEqual({ type: 'text', content: 'Hello!' });
      expect(chunks).toContainEqual({ type: 'done' });
      expect(findCall('thread/start')).toBeDefined();
    });

    it('sends reasoning summary off for GPT-5.3 Codex Spark turns', async () => {
      runtime.cleanup();
      runtime = new CodexChatRuntime(createMockPlugin({
        model: CODEX_SPARK_MODEL,
        providerConfigs: {
          codex: {
            customModels: CODEX_SPARK_MODEL,
            reasoningSummary: 'detailed',
          },
        },
      }));

      await collectChunks(runtime.query(createTurn('hi')));

      const turnStartCall = findCall('turn/start');
      expect(turnStartCall[1]).toMatchObject({
        model: CODEX_SPARK_MODEL,
        summary: 'none',
      });
    });

    it('sends the configured reasoning summary for other Codex models', async () => {
      runtime.cleanup();
      runtime = new CodexChatRuntime(createMockPlugin({
        providerConfigs: {
          codex: {
            reasoningSummary: 'concise',
          },
        },
      }));

      await collectChunks(runtime.query(createTurn('hi')));

      const turnStartCall = findCall('turn/start');
      expect(turnStartCall[1]).toMatchObject({
        model: DEFAULT_CODEX_PRIMARY_MODEL,
        summary: 'concise',
      });
    });

    it('derives WSL transcript and memories roots from thread paths when initialize omits codexHome', async () => {
      mockResolveLaunchSpec.mockReturnValue(createWslLaunchSpec());
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test/0.1',
            platformFamily: 'unix',
            platformOs: 'linux',
          };
        }

        if (method === 'thread/start') {
          return {
            ...threadStartResponse('thread-wsl-no-home'),
            thread: {
              ...threadStartResponse('thread-wsl-no-home').thread,
              path: '/home/user/.codex/sessions/2026/04/14/thread-wsl-no-home.jsonl',
            },
          };
        }

        if (method === 'turn/start') {
          setTimeout(() => {
            emitNotification('turn/completed', {
              threadId: 'thread-wsl-no-home',
              turn: { id: 'turn-wsl-no-home', items: [], status: 'completed', error: null },
            });
          }, 0);
          return turnStartResponse('turn-wsl-no-home');
        }

        return {};
      });

      await collectChunks(runtime.query(createTurn('hi')));

      const turnStartCall = findCall('turn/start');
      expect(turnStartCall[1].sandboxPolicy).toMatchObject({
        type: 'workspaceWrite',
        writableRoots: expect.arrayContaining([
          '/mnt/c/vault',
          '/home/user/.codex/memories',
        ]),
      });

      const result = runtime.buildSessionUpdates({ conversation: null, sessionInvalidated: false });
      expect((result.updates.providerState as any)).toMatchObject({
        threadId: 'thread-wsl-no-home',
        sessionFilePath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\2026\\04\\14\\thread-wsl-no-home.jsonl',
        transcriptRootPath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions',
      });
    });

    it('uses the launch spec target cwd when starting a WSL-backed thread', async () => {
      mockResolveLaunchSpec.mockReturnValue(createWslLaunchSpec());
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test/0.1',
            codexHome: '/home/user/.codex',
            platformFamily: 'unix',
            platformOs: 'linux',
          };
        }

        if (method === 'thread/start') {
          return threadStartResponse('thread-wsl');
        }

        if (method === 'turn/start') {
          setTimeout(() => {
            emitNotification('turn/completed', {
              threadId: 'thread-wsl',
              turn: { id: 'turn-wsl', items: [], status: 'completed', error: null },
            });
          }, 0);
          return turnStartResponse('turn-wsl');
        }

        return {};
      });

      await collectChunks(runtime.query(createTurn('hi')));

      expect(MockedProcessClass).toHaveBeenCalledWith(expect.objectContaining({
        command: 'wsl.exe',
        targetCwd: '/mnt/c/vault',
      }));
      expect(mockTransportRequest).toHaveBeenCalledWith(
        'thread/start',
        expect.objectContaining({
          cwd: '/mnt/c/vault',
        }),
      );
    });

    it('stores host-readable WSL transcript paths in provider state', async () => {
      mockResolveLaunchSpec.mockReturnValue(createWslLaunchSpec());
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test/0.1',
            codexHome: '/home/user/.codex',
            platformFamily: 'unix',
            platformOs: 'linux',
          };
        }

        if (method === 'thread/start') {
          return {
            ...threadStartResponse('thread-wsl-path'),
            thread: {
              ...threadStartResponse('thread-wsl-path').thread,
              path: '/home/user/.codex/sessions/2026/04/06/thread-wsl-path.jsonl',
            },
          };
        }

        if (method === 'turn/start') {
          setTimeout(() => {
            emitNotification('turn/completed', {
              threadId: 'thread-wsl-path',
              turn: { id: 'turn-wsl-path', items: [], status: 'completed', error: null },
            });
          }, 0);
          return turnStartResponse('turn-wsl-path');
        }

        return {};
      });

      await collectChunks(runtime.query(createTurn('hi')));

      const result = runtime.buildSessionUpdates({ conversation: null, sessionInvalidated: false });
      expect((result.updates.providerState as any)).toMatchObject({
        threadId: 'thread-wsl-path',
        sessionFilePath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\2026\\04\\06\\thread-wsl-path.jsonl',
        transcriptRootPath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions',
      });
    });

    it('passes baseInstructions (no temp file)', async () => {
      const plugin = createMockPlugin({ systemPrompt: 'Be helpful.' });
      const rt = new CodexChatRuntime(plugin);

      await collectChunks(rt.query(createTurn()));

      const threadStartCall = findCall('thread/start');
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

      const resumeCall = findCall('thread/resume');
      expect(resumeCall).toBeDefined();
      expect(resumeCall[1].threadId).toBe('thread-existing');
      expect(resumeCall[1].baseInstructions).toBeDefined();

      const startCall = findCall('thread/start');
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

      const startCall = findCall('thread/start');
      const resumeCall = findCall('thread/resume');
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
      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-tools'),
        'turn/start': () => {
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
        },
      }));

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

      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => {
          const response = threadStartResponse('thread-tail');
          response.thread.path = sessionFilePath;
          return response;
        },
        'turn/start': () => {
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
        },
      }));

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
      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-fail'),
        'turn/start': () => {
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
        },
      }));

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
      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-cancel'),
        'turn/start': () => turnStartResponse('turn-cancel'),
        'turn/interrupt': () => ({}),
      }));

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

    it('resolveSessionIdForFork falls back to conversation.sessionId', () => {
      expect(runtime.resolveSessionIdForFork({
        id: 'conv-legacy',
        providerId: 'codex',
        title: 'Legacy Codex Conversation',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: 'legacy-session',
        providerState: {
          forkSource: { sessionId: 'source-thread', resumeAt: 'turn-1' },
        },
        messages: [],
      })).toBe('legacy-session');
    });
  });

  describe('query - image support', () => {
    it('attaches structured skill inputs for explicit $skill references', async () => {
      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-skill'),
        'skills/list': (params: Record<string, unknown>) => {
          expect(params.cwds).toEqual(['/test/vault']);
          return {
            data: [
              {
                cwd: '/test/vault',
                skills: [
                  {
                    name: 'analyze',
                    description: 'Analyze code',
                    path: '/test/vault/.codex/skills/analyze/SKILL.md',
                    scope: 'repo',
                    enabled: true,
                  },
                ],
                errors: [],
              },
            ],
          };
        },
        'turn/start': () => {
          setTimeout(() => {
            emitNotification('turn/completed', {
              threadId: 'thread-skill',
              turn: { id: 'turn-skill', items: [], status: 'completed', error: null },
            });
          }, 0);
          return turnStartResponse('turn-skill');
        },
      }));

      await collectChunks(runtime.query(createTurn('$analyze inspect this repo')));

      expect(findCall('skills/list')).toBeDefined();
      expect(findCall('turn/start')?.[1]?.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: '$analyze inspect this repo' }),
          expect.objectContaining({
            type: 'skill',
            name: 'analyze',
            path: '/test/vault/.codex/skills/analyze/SKILL.md',
          }),
        ]),
      );
    });

    it('converts image attachments to localImage inputs', async () => {
      const turn = createTurn('describe this');
      turn.request.images = [
        { id: 'img1', name: 'test.png', data: Buffer.from('fake-png').toString('base64'), mediaType: 'image/png', size: 100, source: 'file' as const },
      ];

      await collectChunks(runtime.query(turn));

      const turnStartCall = findCall('turn/start');
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

      const turnStartCall = findCall('turn/start');
      const imageInput = turnStartCall?.[1]?.input?.find((item: Record<string, unknown>) => item.type === 'localImage');

      expect(imageInput).toBeDefined();
      expect(fs.existsSync(imageInput.path as string)).toBe(false);
      expect(fs.existsSync(path.dirname(imageInput.path as string))).toBe(false);
    });

    it('maps localImage paths through the launch spec path mapper for WSL', async () => {
      mockResolveLaunchSpec.mockReturnValue(createWslLaunchSpec());
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test/0.1',
            codexHome: '/home/user/.codex',
            platformFamily: 'unix',
            platformOs: 'linux',
          };
        }

        if (method === 'thread/start') {
          return threadStartResponse('thread-image-wsl');
        }

        if (method === 'turn/start') {
          setTimeout(() => {
            emitNotification('turn/completed', {
              threadId: 'thread-image-wsl',
              turn: { id: 'turn-image-wsl', items: [], status: 'completed', error: null },
            });
          }, 0);
          return turnStartResponse('turn-image-wsl');
        }

        return {};
      });

      const turn = createTurn('describe this');
      turn.request.images = [
        { id: 'img1', name: 'test.png', data: Buffer.from('fake-png').toString('base64'), mediaType: 'image/png', size: 100, source: 'file' as const },
      ];

      await collectChunks(runtime.query(turn));

      const turnStartCall = findCall('turn/start');
      const imageInput = turnStartCall?.[1]?.input?.find((item: Record<string, unknown>) => item.type === 'localImage');

      expect(imageInput).toBeDefined();
      expect(imageInput.path).toContain('/mnt/c/');
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

      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-dismiss'),
        'turn/start': () => {
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
        },
      }));

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

      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-cancel-dismiss'),
        'turn/start': () => turnStartResponse('turn-cancel-dismiss'),
        'turn/interrupt': () => ({}),
      }));

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

      const resumeCall = findCall('thread/resume');
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

      const resumeCall = findCall('thread/resume');
      expect(resumeCall).toBeDefined();
      expect(resumeCall[1].model).toBe('gpt-5.4-mini');

      rt.cleanup();
    });

    it('sends serviceTier on thread/resume when fast mode is enabled', async () => {
      const plugin = createMockPlugin({ model: DEFAULT_CODEX_PRIMARY_MODEL, serviceTier: 'fast' });
      const rt = new CodexChatRuntime(plugin);

      rt.syncConversationState({
        sessionId: 'thread-resume-fast',
        providerState: { threadId: 'thread-resume-fast' },
      });

      setupDefaultRequestMock('thread-resume-fast');
      captureHandlers();

      await collectChunks(rt.query(createTurn()));

      const resumeCall = findCall('thread/resume');
      expect(resumeCall).toBeDefined();
      expect(resumeCall[1].serviceTier).toBe('fast');

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

      const turnStartCall = findCall('turn/start');
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

      const threadStartCall = findCall('thread/start');
      expect(threadStartCall[1].sandbox).toBe('danger-full-access');
      expect(threadStartCall[1].approvalPolicy).toBe('never');

      yoloRuntime.cleanup();
    });

    it('sends serviceTier fast on thread/start and turn/start when fast mode is enabled', async () => {
      const plugin = createMockPlugin({ serviceTier: 'fast' });
      const rt = new CodexChatRuntime(plugin);

      await collectChunks(rt.query(createTurn()));

      const threadStartCall = findCall('thread/start');
      const turnStartCall = findCall('turn/start');
      expect(threadStartCall[1].serviceTier).toBe('fast');
      expect(turnStartCall[1].serviceTier).toBe('fast');

      rt.cleanup();
    });

    it('sends serviceTier null on turn/start when fast mode is disabled', async () => {
      const plugin = createMockPlugin({ serviceTier: 'default' });
      const rt = new CodexChatRuntime(plugin);

      await collectChunks(rt.query(createTurn()));

      const turnStartCall = findCall('turn/start');
      expect(turnStartCall[1].serviceTier).toBeNull();

      rt.cleanup();
    });

    it('uses workspace-write with on-request for normal mode', async () => {
      const plugin = createMockPlugin({ permissionMode: 'normal' });
      const safeRuntime = new CodexChatRuntime(plugin);

      await collectChunks(safeRuntime.query(createTurn()));

      const threadStartCall = findCall('thread/start');
      expect(threadStartCall[1].sandbox).toBe('workspace-write');
      expect(threadStartCall[1].approvalPolicy).toBe('on-request');

      safeRuntime.cleanup();
    });

    it('falls back to normal mode for unrecognized permissionMode', async () => {
      const plugin = createMockPlugin({ permissionMode: 'plan' });
      const rt = new CodexChatRuntime(plugin);

      await collectChunks(rt.query(createTurn()));

      const threadStartCall = findCall('thread/start');
      expect(threadStartCall[1].sandbox).toBe('workspace-write');
      expect(threadStartCall[1].approvalPolicy).toBe('on-request');

      rt.cleanup();
    });

    it('always sends baseline sandboxPolicy even without external context', async () => {
      const plugin = createMockPlugin({ permissionMode: 'normal' });
      const rt = new CodexChatRuntime(plugin);

      await collectChunks(rt.query(createTurn()));

      const turnStartCall = findCall('turn/start');
      expect(turnStartCall[1].sandboxPolicy).toBeDefined();
      expect(turnStartCall[1].sandboxPolicy.type).toBe('workspaceWrite');
      expect(turnStartCall[1].sandboxPolicy.writableRoots).toContain('/test/vault');

      rt.cleanup();
    });

    it('sends explicit dangerFullAccess sandboxPolicy in yolo mode', async () => {
      const plugin = createMockPlugin({ permissionMode: 'yolo' });
      const rt = new CodexChatRuntime(plugin);

      await collectChunks(rt.query(createTurn()));

      const turnStartCall = findCall('turn/start');
      expect(turnStartCall[1].sandboxPolicy).toEqual({ type: 'dangerFullAccess' });

      rt.cleanup();
    });

    it('sends sandboxPolicy with external context writable roots in normal mode', async () => {
      const turn = createTurn('inspect both locations');
      turn.request.externalContextPaths = ['/external/a', '/external/b'];

      await collectChunks(runtime.query(turn));

      const turnStartCall = findCall('turn/start');

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

    it('maps external context and memory roots into the target filesystem for WSL', async () => {
      mockResolveLaunchSpec.mockReturnValue(createWslLaunchSpec({
        pathMapper: {
          target: {
            method: 'wsl',
            platformFamily: 'unix',
            platformOs: 'linux',
            distroName: 'Ubuntu',
          },
          toTargetPath: jest.fn((value: string) => {
            if (value.startsWith('/tmp/')) {
              return value.replace('/tmp/', '/mnt/c/tmp/');
            }
            if (value.startsWith('/external/')) {
              return value.replace('/external/', '/mnt/d/external/');
            }
            return `/mnt/c/${value.replace(/^\/+/, '')}`;
          }),
          toHostPath: jest.fn((value: string) => {
            if (value === '/home/user/.codex') return '\\\\wsl$\\Ubuntu\\home\\user\\.codex';
            if (value === '/home/user/.codex/sessions') return '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions';
            return value;
          }),
          mapTargetPathList: jest.fn((values: string[]) => values.map(value => value.replace('/external/', '/mnt/d/external/'))),
          canRepresentHostPath: jest.fn(() => true),
        },
      }));
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test/0.1',
            codexHome: '/home/user/.codex',
            platformFamily: 'unix',
            platformOs: 'linux',
          };
        }

        if (method === 'thread/start') {
          return threadStartResponse('thread-wsl-sandbox');
        }

        if (method === 'turn/start') {
          setTimeout(() => {
            emitNotification('turn/completed', {
              threadId: 'thread-wsl-sandbox',
              turn: { id: 'turn-wsl-sandbox', items: [], status: 'completed', error: null },
            });
          }, 0);
          return turnStartResponse('turn-wsl-sandbox');
        }

        return {};
      });

      const turn = createTurn('inspect both locations');
      turn.request.externalContextPaths = ['/external/a', '/external/b'];

      await collectChunks(runtime.query(turn));

      const turnStartCall = findCall('turn/start');
      expect(turnStartCall[1].sandboxPolicy).toMatchObject({
        type: 'workspaceWrite',
        writableRoots: expect.arrayContaining([
          '/mnt/c/vault',
          '/mnt/d/external/a',
          '/mnt/d/external/b',
          '/home/user/.codex/memories',
        ]),
      });
    });

    it('fails with a clear error when an external context path cannot be mapped into WSL', async () => {
      mockResolveLaunchSpec.mockReturnValue(createWslLaunchSpec({
        pathMapper: {
          target: {
            method: 'wsl',
            platformFamily: 'unix',
            platformOs: 'linux',
            distroName: 'Ubuntu',
          },
          toTargetPath: jest.fn((value: string) => value === '/external/a' ? null : `/mnt/c/${value.replace(/^\/+/, '')}`),
          toHostPath: jest.fn((value: string) => {
            if (value === '/home/user/.codex') return '\\\\wsl$\\Ubuntu\\home\\user\\.codex';
            if (value === '/home/user/.codex/sessions') return '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions';
            return value;
          }),
          mapTargetPathList: jest.fn(),
          canRepresentHostPath: jest.fn(() => true),
        },
      }));
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') {
          return {
            userAgent: 'test/0.1',
            codexHome: '/home/user/.codex',
            platformFamily: 'unix',
            platformOs: 'linux',
          };
        }

        if (method === 'thread/start') {
          return threadStartResponse('thread-wsl-error');
        }

        return {};
      });

      const turn = createTurn('inspect location');
      turn.request.externalContextPaths = ['/external/a'];

      const chunks = await collectChunks(runtime.query(turn));

      expect(chunks).toContainEqual({
        type: 'error',
        content: 'Codex cannot access external context path from the selected target: /external/a',
      });
    });
  });

  describe('query - codexSafeMode read-only', () => {
    it('sends sandbox read-only on thread/resume when codexSafeMode is read-only', async () => {
      const plugin = createMockPlugin({ permissionMode: 'normal', codexSafeMode: 'read-only' });
      const rt = new CodexChatRuntime(plugin);

      rt.syncConversationState({
        sessionId: 'thread-resume-read-only',
        providerState: { threadId: 'thread-resume-read-only', sessionFilePath: '/tmp/resume.jsonl' },
      });

      setupDefaultRequestMock('thread-resume-read-only');
      captureHandlers();

      await collectChunks(rt.query(createTurn('resume')));

      const resumeCall = findCall('thread/resume');
      expect(resumeCall).toBeDefined();
      expect(resumeCall[1].sandbox).toBe('read-only');
      expect(resumeCall[1].approvalPolicy).toBe('on-request');

      rt.cleanup();
    });

    it('sends sandbox read-only on thread/start when codexSafeMode is read-only', async () => {
      const plugin = createMockPlugin({ permissionMode: 'normal', codexSafeMode: 'read-only' });
      const rt = new CodexChatRuntime(plugin);
      captureHandlers();
      setupDefaultRequestMock();

      const turn = createTurn('hello');
      await collectChunks(rt.query(turn));

      const threadStartCall = findCall('thread/start');
      expect(threadStartCall[1].sandbox).toBe('read-only');
      expect(threadStartCall[1].approvalPolicy).toBe('on-request');
    });

    it('sends readOnly sandboxPolicy on turn/start when codexSafeMode is read-only', async () => {
      const plugin = createMockPlugin({ permissionMode: 'normal', codexSafeMode: 'read-only' });
      const rt = new CodexChatRuntime(plugin);
      captureHandlers();
      setupDefaultRequestMock();

      const turn = createTurn('hello');
      await collectChunks(rt.query(turn));

      const turnStartCall = findCall('turn/start');
      expect(turnStartCall[1].sandboxPolicy).toEqual({
        type: 'readOnly',
        access: { type: 'fullAccess' },
        networkAccess: false,
      });
    });

    it('reasserts readOnly sandboxPolicy on already-loaded threads when codexSafeMode changes', async () => {
      const plugin = createMockPlugin({ permissionMode: 'normal', codexSafeMode: 'workspace-write' });
      const rt = new CodexChatRuntime(plugin);

      await collectChunks(rt.query(createTurn('first')));

      mockTransportRequest.mockClear();
      captureHandlers();
      setupDefaultRequestMock('thread-001', 'turn-002');

      plugin.settings.codexSafeMode = 'read-only';
      await collectChunks(rt.query(createTurn('second')));

      const turnStartCall = findCall('turn/start');
      expect(turnStartCall).toBeDefined();
      expect(turnStartCall[1].approvalPolicy).toBe('on-request');
      expect(turnStartCall[1].sandboxPolicy).toEqual({
        type: 'readOnly',
        access: { type: 'fullAccess' },
        networkAccess: false,
      });

      rt.cleanup();
    });
  });

  describe('query - user_message_id emission', () => {
    it('records user message metadata after turn/start', async () => {
      await collectChunks(runtime.query(createTurn('hi')));

      expect(runtime.consumeTurnMetadata()).toMatchObject({
        userMessageId: 'turn-001',
        wasSent: true,
      });
    });
  });

  describe('steer', () => {
    it('sends turn/steer for the active turn', async () => {
      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-steer'),
        'turn/start': () => turnStartResponse('turn-steer'),
        'turn/steer': () => ({ turnId: 'turn-steer' }),
      }));

      const queryPromise = collectChunks(runtime.query(createTurn('start here')));
      await new Promise(r => setTimeout(r, 0));

      await expect(runtime.steer?.(createTurn('follow up'))).resolves.toBe(true);

      emitNotification('turn/completed', {
        threadId: 'thread-steer',
        turn: { id: 'turn-steer', items: [], status: 'completed', error: null },
      });
      await queryPromise;

      expect(findCall('turn/steer')).toEqual([
        'turn/steer',
        {
          threadId: 'thread-steer',
          expectedTurnId: 'turn-steer',
          input: [{ type: 'text', text: 'follow up', text_elements: [] }],
        },
      ]);
    });

    it('returns false when there is no active turn to steer', async () => {
      await expect(runtime.steer?.(createTurn('follow up'))).resolves.toBe(false);
    });
  });

  describe('query - plan mode (collaborationMode)', () => {
    it('includes collaborationMode in turn/start when permissionMode is plan', async () => {
      const plugin = createMockPlugin({ permissionMode: 'plan' });
      const rt = new CodexChatRuntime(plugin);
      captureHandlers();
      setupDefaultRequestMock();

      await collectChunks(rt.query(createTurn('plan this')));

      const turnStartCall = findCall('turn/start');
      expect(turnStartCall).toBeDefined();
      expect(turnStartCall[1].collaborationMode).toEqual({
        mode: 'plan',
        settings: {
          model: DEFAULT_CODEX_PRIMARY_MODEL,
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      });

      rt.cleanup();
    });

    it('includes default collaborationMode when permissionMode is normal', async () => {
      const plugin = createMockPlugin({ permissionMode: 'normal' });
      const rt = new CodexChatRuntime(plugin);
      captureHandlers();
      setupDefaultRequestMock();

      await collectChunks(rt.query(createTurn('hello')));

      const turnStartCall = findCall('turn/start');
      expect(turnStartCall).toBeDefined();
      expect(turnStartCall[1].collaborationMode).toEqual({
        mode: 'default',
        settings: {
          model: DEFAULT_CODEX_PRIMARY_MODEL,
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      });

      rt.cleanup();
    });

    it('includes default collaborationMode when permissionMode is yolo', async () => {
      const plugin = createMockPlugin({ permissionMode: 'yolo' });
      const rt = new CodexChatRuntime(plugin);
      captureHandlers();
      setupDefaultRequestMock();

      await collectChunks(rt.query(createTurn('hello')));

      const turnStartCall = findCall('turn/start');
      expect(turnStartCall).toBeDefined();
      expect(turnStartCall[1].collaborationMode).toEqual({
        mode: 'default',
        settings: {
          model: DEFAULT_CODEX_PRIMARY_MODEL,
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      });

      rt.cleanup();
    });

    it('sends default collaborationMode after switching out of plan mode on the same thread', async () => {
      const plugin = createMockPlugin({ permissionMode: 'plan' });
      const rt = new CodexChatRuntime(plugin);
      captureHandlers();
      setupDefaultRequestMock();

      await collectChunks(rt.query(createTurn('plan this')));

      plugin.settings.permissionMode = 'normal';
      await collectChunks(rt.query(createTurn('now edit')));

      const turnStartCalls = mockTransportRequest.mock.calls.filter(
        (call: any[]) => call[0] === 'turn/start',
      );
      expect(turnStartCalls).toHaveLength(2);
      expect(turnStartCalls[0][1].collaborationMode).toEqual({
        mode: 'plan',
        settings: {
          model: DEFAULT_CODEX_PRIMARY_MODEL,
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      });
      expect(turnStartCalls[1][1].collaborationMode).toEqual({
        mode: 'default',
        settings: {
          model: DEFAULT_CODEX_PRIMARY_MODEL,
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      });

      rt.cleanup();
    });

    it('configures router beginTurn before turn/start so buffered notifications see plan state', async () => {
      const plugin = createMockPlugin({ permissionMode: 'plan' });
      const rt = new CodexChatRuntime(plugin);
      captureHandlers();

      // Intercept the turn/start request to verify router state was set before it
      let routerBeginCalledBeforeTurnStart = false;
      mockTransportRequest.mockImplementation(async (method: string) => {
        if (method === 'initialize') return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
        if (method === 'thread/start') return threadStartResponse('thread-plan');
        if (method === 'turn/start') {
          // Access the router via the runtime's private field to check beginTurn was called
          const router = (rt as any).notificationRouter;
          if (router && router.isPlanTurn === true) {
            routerBeginCalledBeforeTurnStart = true;
          }
          setTimeout(() => {
            emitNotification('turn/completed', {
              threadId: 'thread-plan',
              turn: { id: 'turn-plan', items: [], status: 'completed', error: null },
            });
          }, 0);
          return turnStartResponse('turn-plan');
        }
        return {};
      });

      await collectChunks(rt.query(createTurn('plan it')));
      expect(routerBeginCalledBeforeTurnStart).toBe(true);

      rt.cleanup();
    });
  });

  describe('query - pending fork lifecycle', () => {
    it('syncConversationState with forkSource sets pending fork without setting session', () => {
      runtime.syncConversationState({
        sessionId: null,
        providerState: { forkSource: { sessionId: 'source-thread', resumeAt: 'turn-uuid-2' } },
      });

      // Session should not be set to the source thread
      expect(runtime.getSessionId()).toBeNull();
    });

    it('first query with pending fork issues fork + resume + rollback + turn/start', async () => {
      runtime.syncConversationState({
        sessionId: null,
        providerState: { forkSource: { sessionId: 'source-thread', resumeAt: 'turn-uuid-2' } },
      });

      mockTransportRequest.mockImplementation(async (method: string) => {
        switch (method) {
          case 'initialize':
            return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
          case 'thread/fork': {
            const resp = threadStartResponse('fork-thread-1');
            resp.thread.turns = [
              { id: 'turn-uuid-1', items: [], status: 'completed', error: null },
              { id: 'turn-uuid-2', items: [], status: 'completed', error: null },
              { id: 'turn-uuid-3', items: [], status: 'completed', error: null },
            ];
            return resp;
          }
          case 'thread/resume':
            return threadStartResponse('fork-thread-1');
          case 'thread/rollback':
            return { thread: { ...threadStartResponse('fork-thread-1').thread, turns: [] } };
          case 'turn/start':
            setTimeout(() => {
              emitNotification('item/agentMessage/delta', {
                threadId: 'fork-thread-1', turnId: 'fork-turn-1', itemId: 'msg1', delta: 'Forked reply',
              });
              emitNotification('turn/completed', {
                threadId: 'fork-thread-1',
                turn: { id: 'fork-turn-1', items: [], status: 'completed', error: null },
              });
            }, 0);
            return turnStartResponse('fork-turn-1');
          default:
            return {};
        }
      });

      captureHandlers();
      const chunks = await collectChunks(runtime.query(createTurn('forked input')));

      // Verify request sequence: fork, resume, rollback, turn/start
      const calls = mockTransportRequest.mock.calls.map((c: any[]) => c[0]);
      const lifecycle = calls.filter((m: string) =>
        ['thread/fork', 'thread/resume', 'thread/rollback', 'turn/start'].includes(m),
      );
      expect(lifecycle).toEqual(['thread/fork', 'thread/resume', 'thread/rollback', 'turn/start']);

      // Verify fork params
      const forkCall = findCall('thread/fork');
      expect(forkCall[1].threadId).toBe('source-thread');

      // Verify resume params
      const resumeCall = findCall('thread/resume');
      expect(resumeCall[1].threadId).toBe('fork-thread-1');

      // Verify rollback params (1 turn after checkpoint: turn-uuid-3)
      const rollbackCall = findCall('thread/rollback');
      expect(rollbackCall[1].threadId).toBe('fork-thread-1');
      expect(rollbackCall[1].numTurns).toBe(1);

      expect(chunks).toContainEqual({ type: 'text', content: 'Forked reply' });
      expect(chunks).toContainEqual({ type: 'done' });

      // After fork, session should be the fork thread
      expect(runtime.getSessionId()).toBe('fork-thread-1');
    });

    it('skips rollback when resumeAt is the last turn', async () => {
      runtime.syncConversationState({
        sessionId: null,
        providerState: { forkSource: { sessionId: 'source-thread-2', resumeAt: 'turn-uuid-last' } },
      });

      const requestSequence: string[] = [];
      mockTransportRequest.mockImplementation(async (method: string) => {
        requestSequence.push(method);
        switch (method) {
          case 'initialize':
            return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
          case 'thread/fork': {
            const resp = threadStartResponse('fork-no-rb');
            resp.thread.turns = [
              { id: 'turn-uuid-first', items: [], status: 'completed', error: null },
              { id: 'turn-uuid-last', items: [], status: 'completed', error: null },
            ];
            return resp;
          }
          case 'thread/resume':
            return threadStartResponse('fork-no-rb');
          case 'turn/start':
            setTimeout(() => {
              emitNotification('turn/completed', {
                threadId: 'fork-no-rb',
                turn: { id: 'fork-turn-nr', items: [], status: 'completed', error: null },
              });
            }, 0);
            return turnStartResponse('fork-turn-nr');
          default:
            return {};
        }
      });

      captureHandlers();
      await collectChunks(runtime.query(createTurn('no rollback needed')));

      // Should NOT have called thread/rollback
      expect(requestSequence).not.toContain('thread/rollback');
    });

    it('retries the pending fork instead of starting a fresh thread after a fork failure', async () => {
      runtime.syncConversationState({
        sessionId: null,
        providerState: { forkSource: { sessionId: 'source-thread-retry', resumeAt: 'turn-uuid-2' } },
      });

      let forkAttempts = 0;
      mockTransportRequest.mockImplementation(async (method: string) => {
        switch (method) {
          case 'initialize':
            return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
          case 'thread/fork':
            forkAttempts += 1;
            if (forkAttempts === 1) {
              throw new Error('fork failed');
            }
            return {
              ...threadStartResponse('fork-thread-retry'),
              thread: {
                ...threadStartResponse('fork-thread-retry').thread,
                turns: [
                  { id: 'turn-uuid-1', items: [], status: 'completed', error: null },
                  { id: 'turn-uuid-2', items: [], status: 'completed', error: null },
                ],
              },
            };
          case 'thread/resume':
            return threadStartResponse('fork-thread-retry');
          case 'turn/start':
            setTimeout(() => {
              emitNotification('turn/completed', {
                threadId: 'fork-thread-retry',
                turn: { id: 'fork-turn-retry', items: [], status: 'completed', error: null },
              });
            }, 0);
            return turnStartResponse('fork-turn-retry');
          default:
            return {};
        }
      });

      captureHandlers();
      const firstAttemptChunks = await collectChunks(runtime.query(createTurn('first attempt')));

      expect(firstAttemptChunks).toContainEqual({ type: 'error', content: 'fork failed' });
      expect(runtime.getSessionId()).toBeNull();

      mockTransportRequest.mockClear();
      captureHandlers();
      const retryChunks = await collectChunks(runtime.query(createTurn('retry after fork failure')));

      const retryLifecycle = mockTransportRequest.mock.calls
        .map((call: any[]) => call[0])
        .filter((method: string) => ['thread/fork', 'thread/resume', 'thread/start', 'turn/start'].includes(method));

      expect(retryLifecycle).toEqual(['thread/fork', 'thread/resume', 'turn/start']);
      expect(retryChunks).toContainEqual({ type: 'done' });
      expect(runtime.getSessionId()).toBe('fork-thread-retry');
    });

    it('fails the fork when the resumeAt checkpoint is missing from the fork result', async () => {
      runtime.syncConversationState({
        sessionId: null,
        providerState: { forkSource: { sessionId: 'source-thread-missing', resumeAt: 'turn-uuid-missing' } },
      });

      mockTransportRequest.mockImplementation(async (method: string) => {
        switch (method) {
          case 'initialize':
            return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
          case 'thread/fork':
            return {
              ...threadStartResponse('fork-thread-missing'),
              thread: {
                ...threadStartResponse('fork-thread-missing').thread,
                turns: [
                  { id: 'turn-uuid-1', items: [], status: 'completed', error: null },
                  { id: 'turn-uuid-2', items: [], status: 'completed', error: null },
                ],
              },
            };
          default:
            return {};
        }
      });

      captureHandlers();
      const chunks = await collectChunks(runtime.query(createTurn('fork with missing checkpoint')));

      expect(chunks).toContainEqual({
        type: 'error',
        content: 'Fork checkpoint not found: turn-uuid-missing',
      });
      expect(chunks).toContainEqual({ type: 'done' });

      const methods = mockTransportRequest.mock.calls.map((call: any[]) => call[0]);
      expect(methods).toContain('thread/fork');
      expect(methods).not.toContain('thread/resume');
      expect(methods).not.toContain('turn/start');
      expect(runtime.getSessionId()).toBeNull();
    });

    it('buildSessionUpdates preserves forkSource after fork thread established', async () => {
      // Simulate an established fork conversation
      runtime.syncConversationState({
        sessionId: null,
        providerState: {
          forkSource: { sessionId: 'source-thread', resumeAt: 'turn-uuid-2' },
          forkSourceSessionFilePath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\source-thread.jsonl',
          forkSourceTranscriptRootPath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions',
        },
      });

      mockTransportRequest.mockImplementation(async (method: string) => {
        switch (method) {
          case 'initialize':
            return { userAgent: 'test/0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
          case 'thread/fork': {
            const resp = threadStartResponse('fork-established');
            resp.thread.turns = [
              { id: 'turn-uuid-1', items: [], status: 'completed', error: null },
              { id: 'turn-uuid-2', items: [], status: 'completed', error: null },
            ];
            return resp;
          }
          case 'thread/resume':
            return threadStartResponse('fork-established');
          case 'turn/start':
            setTimeout(() => {
              emitNotification('turn/completed', {
                threadId: 'fork-established',
                turn: { id: 'fork-t1', items: [], status: 'completed', error: null },
              });
            }, 0);
            return turnStartResponse('fork-t1');
          default:
            return {};
        }
      });

      captureHandlers();
      await collectChunks(runtime.query(createTurn('first fork turn')));

      const result = runtime.buildSessionUpdates({
        conversation: {
          id: 'conv-1',
          providerId: 'codex',
          title: 'Fork',
          createdAt: 0,
          updatedAt: 0,
          sessionId: null,
          messages: [],
          providerState: {
            forkSource: { sessionId: 'source-thread', resumeAt: 'turn-uuid-2' },
            forkSourceSessionFilePath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\source-thread.jsonl',
            forkSourceTranscriptRootPath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions',
          },
        },
        sessionInvalidated: false,
      });

      expect((result.updates.providerState as any).threadId).toBe('fork-established');
      expect((result.updates.providerState as any).forkSource).toEqual({
        sessionId: 'source-thread',
        resumeAt: 'turn-uuid-2',
      });
      expect((result.updates.providerState as any).forkSourceSessionFilePath).toBe(
        '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\source-thread.jsonl',
      );
      expect((result.updates.providerState as any).forkSourceTranscriptRootPath).toBe(
        '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions',
      );
    });

    it('resetSession clears pending fork', () => {
      runtime.syncConversationState({
        sessionId: null,
        providerState: { forkSource: { sessionId: 'source', resumeAt: 'turn-1' } },
      });

      runtime.resetSession();

      // After reset, a normal query should start a new thread (not fork)
      expect(runtime.getSessionId()).toBeNull();
    });
  });

  describe('query - manual compact', () => {
    it('calls thread/compact/start instead of turn/start for compact turns', async () => {
      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-compact'),
        'thread/compact/start': () => {
          setTimeout(() => {
            emitNotification('turn/started', {
              threadId: 'thread-compact',
              turn: { id: 'turn-compact', items: [], status: 'inProgress', error: null },
            });
            emitNotification('item/started', {
              item: { type: 'contextCompaction', id: 'compact-1' },
              threadId: 'thread-compact',
              turnId: 'turn-compact',
            });
            emitNotification('item/completed', {
              item: { type: 'contextCompaction', id: 'compact-1' },
              threadId: 'thread-compact',
              turnId: 'turn-compact',
            });
            emitNotification('turn/completed', {
              threadId: 'thread-compact',
              turn: { id: 'turn-compact', items: [], status: 'completed', error: null },
            });
          }, 0);
          return {};
        },
      }));

      const chunks = await collectChunks(runtime.query(createCompactTurn()));

      expect(mockTransportRequest).toHaveBeenCalledWith(
        'thread/compact/start',
        { threadId: 'thread-compact' },
      );
      const turnStartCall = findCall('turn/start');
      expect(turnStartCall).toBeUndefined();

      expect(chunks).toContainEqual({ type: 'context_compacted' });
      expect(chunks).toContainEqual({ type: 'done' });
    });

    it('creates a new thread first if none exists, then compacts', async () => {
      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-new-compact'),
        'thread/compact/start': () => {
          setTimeout(() => {
            emitNotification('turn/started', {
              threadId: 'thread-new-compact',
              turn: { id: 'turn-c', items: [], status: 'inProgress', error: null },
            });
            emitNotification('item/started', {
              item: { type: 'contextCompaction', id: 'compact-2' },
              threadId: 'thread-new-compact',
              turnId: 'turn-c',
            });
            emitNotification('turn/completed', {
              threadId: 'thread-new-compact',
              turn: { id: 'turn-c', items: [], status: 'completed', error: null },
            });
          }, 0);
          return {};
        },
      }));

      await collectChunks(runtime.query(createCompactTurn()));

      expect(mockTransportRequest).toHaveBeenCalledWith(
        'thread/start',
        expect.any(Object),
      );
      expect(mockTransportRequest).toHaveBeenCalledWith(
        'thread/compact/start',
        { threadId: 'thread-new-compact' },
      );
    });

    it('rejects /compact with extra arguments locally', async () => {
      const turn = createTurn('/compact extra args', { isCompact: true });

      mockTransportRequest.mockImplementation(buildRequestHandler({}));

      const chunks = await collectChunks(runtime.query(turn));

      expect(chunks).toContainEqual(expect.objectContaining({
        type: 'error',
        content: expect.stringContaining('/compact'),
      }));
      expect(chunks).toContainEqual({ type: 'done' });

      const compactCall = findCall('thread/compact/start');
      expect(compactCall).toBeUndefined();

      const threadStartCall = findCall('thread/start');
      expect(threadStartCall).toBeUndefined();
      expect(runtime.getSessionId()).toBeNull();
    });

    it('does not call buildInput or start transcript tailing for compact', async () => {
      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-no-input'),
        'thread/compact/start': () => {
          setTimeout(() => {
            emitNotification('turn/started', {
              threadId: 'thread-no-input',
              turn: { id: 'turn-ni', items: [], status: 'inProgress', error: null },
            });
            emitNotification('turn/completed', {
              threadId: 'thread-no-input',
              turn: { id: 'turn-ni', items: [], status: 'completed', error: null },
            });
          }, 0);
          return {};
        },
      }));

      await collectChunks(runtime.query(createCompactTurn()));

      // turn/start was never called, which means buildInput was never called
      const turnStartCall = findCall('turn/start');
      expect(turnStartCall).toBeUndefined();
    });

    it('preserves cancel semantics: cancel before turn/started does not crash', async () => {
      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-cancel-compact'),
        // Don't emit turn/started - simulating cancel before it arrives
        'thread/compact/start': () => ({}),
        'turn/interrupt': () => ({}),
      }));

      const gen = runtime.query(createCompactTurn());
      const firstResult = gen.next();
      await new Promise(r => setTimeout(r, 50));

      runtime.cancel();

      const chunks: StreamChunk[] = [];
      const first = await firstResult;
      if (!first.done && first.value) chunks.push(first.value);
      for await (const chunk of gen) chunks.push(chunk);

      expect(chunks).toContainEqual({ type: 'done' });
    });

    it('preserves cancel semantics: cancel after turn/started sends turn/interrupt', async () => {
      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-cc2'),
        'thread/compact/start': () => {
          setTimeout(() => {
            emitNotification('turn/started', {
              threadId: 'thread-cc2',
              turn: { id: 'turn-cc2', items: [], status: 'inProgress', error: null },
            });
          }, 0);
          return {};
        },
        'turn/interrupt': () => ({}),
      }));

      const gen = runtime.query(createCompactTurn());
      const firstResult = gen.next();
      await new Promise(r => setTimeout(r, 50));

      runtime.cancel();

      const chunks: StreamChunk[] = [];
      const first = await firstResult;
      if (!first.done && first.value) chunks.push(first.value);
      for await (const chunk of gen) chunks.push(chunk);

      expect(mockTransportRequest).toHaveBeenCalledWith(
        'turn/interrupt',
        { threadId: 'thread-cc2', turnId: 'turn-cc2' },
      );
    });

    it('captures thread ID after compact on a new thread', async () => {
      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-persist'),
        'thread/compact/start': () => {
          setTimeout(() => {
            emitNotification('turn/started', {
              threadId: 'thread-persist',
              turn: { id: 'turn-p', items: [], status: 'inProgress', error: null },
            });
            emitNotification('turn/completed', {
              threadId: 'thread-persist',
              turn: { id: 'turn-p', items: [], status: 'completed', error: null },
            });
          }, 0);
          return {};
        },
      }));

      await collectChunks(runtime.query(createCompactTurn()));

      expect(runtime.getSessionId()).toBe('thread-persist');
      const result = runtime.buildSessionUpdates({ conversation: null, sessionInvalidated: false });
      expect((result.updates.providerState as any).threadId).toBe('thread-persist');
    });
  });

  describe('turn/started notification establishes turn ID', () => {
    it('establishes turn ID from turn/started and flushes buffered notifications', async () => {
      mockTransportRequest.mockImplementation(buildRequestHandler({
        'thread/start': () => threadStartResponse('thread-ts'),
        'thread/compact/start': () => {
          // Simulate: turn/started arrives first, then items, then turn/completed
          setTimeout(() => {
            // Item arrives BEFORE turn/started — gets buffered
            emitNotification('item/agentMessage/delta', {
              threadId: 'thread-ts',
              turnId: 'turn-ts',
              itemId: 'msg-ts',
              delta: 'Buffered text',
            });
            // turn/started arrives and establishes the turn ID
            emitNotification('turn/started', {
              threadId: 'thread-ts',
              turn: { id: 'turn-ts', items: [], status: 'inProgress', error: null },
            });
            emitNotification('turn/completed', {
              threadId: 'thread-ts',
              turn: { id: 'turn-ts', items: [], status: 'completed', error: null },
            });
          }, 0);
          return {};
        },
      }));

      const chunks = await collectChunks(runtime.query(createCompactTurn()));

      // The buffered text should have been flushed after turn/started
      expect(chunks).toContainEqual({ type: 'text', content: 'Buffered text' });
      expect(chunks).toContainEqual({ type: 'done' });
    });
  });
});
