import * as codexSdkMockModule from '@openai/codex-sdk';

import type { PreparedChatTurn } from '@/core/runtime/types';
import type { StreamChunk } from '@/core/types/chat';
import { CodexChatRuntime } from '@/providers/codex/runtime/CodexChatRuntime';

const {
  mockCodexConstructor,
  mockRunStreamed,
  mockStartThread,
  mockResumeThread,
  resetCodexSdkMocks,
} = codexSdkMockModule as unknown as {
  mockCodexConstructor: jest.Mock;
  mockRunStreamed: jest.Mock;
  mockStartThread: jest.Mock;
  mockResumeThread: jest.Mock;
  resetCodexSdkMocks: () => void;
};

jest.mock('@/utils/path', () => ({
  getVaultPath: jest.fn().mockReturnValue('/test/vault'),
}));

function createMockPlugin(): any {
  return {
    settings: {
      model: 'codex-mini',
      effortLevel: 'medium',
    },
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(
      'OPENAI_API_KEY=test-key\nOPENAI_BASE_URL=https://example.test/v1',
    ),
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

async function* makeEvents(events: any[]): AsyncGenerator<any> {
  for (const event of events) {
    yield event;
  }
}

async function collectChunks(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('CodexChatRuntime', () => {
  let runtime: CodexChatRuntime;

  beforeEach(() => {
    resetCodexSdkMocks();
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
  });

  it('passes the configured environment variables to the Codex client', async () => {
    await runtime.ensureReady();

    expect(mockCodexConstructor).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: 'https://example.test/v1',
      }),
    }));
  });

  it('should return empty commands', async () => {
    const commands = await runtime.getSupportedCommands();
    expect(commands).toEqual([]);
  });

  it('should return canRewind: false', async () => {
    const result = await runtime.rewind('u1', 'a1');
    expect(result.canRewind).toBe(false);
  });

  describe('query - text streaming', () => {
    it('should map agent_message events to text chunks with deltas', async () => {
      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_001' },
          { type: 'turn.started' },
          { type: 'item.started', item: { id: 'i1', type: 'agent_message', text: '' } },
          { type: 'item.updated', item: { id: 'i1', type: 'agent_message', text: 'Hello' } },
          { type: 'item.updated', item: { id: 'i1', type: 'agent_message', text: 'Hello world' } },
          { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Hello world' } },
          { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      const textChunks = chunks.filter(c => c.type === 'text');
      expect(textChunks).toEqual([
        { type: 'text', content: 'Hello' },
        { type: 'text', content: ' world' },
      ]);
    });

    it('should map reasoning events to thinking chunks', async () => {
      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_002' },
          { type: 'turn.started' },
          { type: 'item.started', item: { id: 'r1', type: 'reasoning', text: '' } },
          { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Thinking...' } },
          { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 10 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      const thinkingChunks = chunks.filter(c => c.type === 'thinking');
      expect(thinkingChunks).toEqual([
        { type: 'thinking', content: 'Thinking...' },
      ]);
    });
  });

  describe('query - tool events', () => {
    it('should map command_execution to tool_use and tool_result', async () => {
      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_003' },
          { type: 'turn.started' },
          { type: 'item.started', item: { id: 'cmd1', type: 'command_execution', command: 'ls -la', aggregated_output: '', status: 'in_progress' } },
          { type: 'item.completed', item: { id: 'cmd1', type: 'command_execution', command: 'ls -la', aggregated_output: 'file.txt', exit_code: 0, status: 'completed' } },
          { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      const toolUse = chunks.find(c => c.type === 'tool_use');
      const toolResult = chunks.find(c => c.type === 'tool_result');

      expect(toolUse).toEqual({
        type: 'tool_use',
        id: 'cmd1',
        name: 'Bash',
        input: { command: 'ls -la' },
      });
      expect(toolResult).toEqual({
        type: 'tool_result',
        id: 'cmd1',
        content: 'file.txt',
        isError: false,
      });
    });

    it('should map file_change to tool_use and tool_result', async () => {
      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_004' },
          { type: 'turn.started' },
          { type: 'item.started', item: { id: 'fc1', type: 'file_change', changes: [{ path: 'src/main.ts', kind: 'update' }], status: 'completed' } },
          { type: 'item.completed', item: { id: 'fc1', type: 'file_change', changes: [{ path: 'src/main.ts', kind: 'update' }], status: 'completed' } },
          { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      const toolUse = chunks.find(c => c.type === 'tool_use');
      const toolResult = chunks.find(c => c.type === 'tool_result');

      expect(toolUse).toMatchObject({
        type: 'tool_use',
        id: 'fc1',
        name: 'apply_patch',
      });
      expect(toolResult).toMatchObject({
        type: 'tool_result',
        id: 'fc1',
        content: 'Applied: update: src/main.ts',
      });
    });

    it('should map web_search to tool_use and tool_result', async () => {
      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_005' },
          { type: 'turn.started' },
          { type: 'item.started', item: { id: 'ws1', type: 'web_search', query: 'obsidian api' } },
          { type: 'item.completed', item: { id: 'ws1', type: 'web_search', query: 'obsidian api' } },
          { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      const toolUse = chunks.find(c => c.type === 'tool_use');
      const toolResult = chunks.find(c => c.type === 'tool_result');

      expect(toolUse).toMatchObject({
        type: 'tool_use',
        id: 'ws1',
        name: 'WebSearch',
        input: { query: 'obsidian api' },
      });
      expect(toolResult).toMatchObject({
        type: 'tool_result',
        id: 'ws1',
        content: 'Search complete',
      });
    });
  });

  describe('query - turn lifecycle', () => {
    it('should emit usage and done on turn.completed', async () => {
      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_006' },
          { type: 'turn.started' },
          { type: 'turn.completed', usage: { input_tokens: 150, cached_input_tokens: 10, output_tokens: 42 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      const usageChunk = chunks.find(c => c.type === 'usage');
      const doneChunk = chunks.find(c => c.type === 'done');

      expect(usageChunk).toBeDefined();
      expect(usageChunk).toMatchObject({
        type: 'usage',
        usage: {
          inputTokens: 150,
          cacheReadInputTokens: 10,
          contextWindow: 200_000,
          contextTokens: 160,
        },
      });
      // Verify percentage separately due to floating point
      const usage = (usageChunk as { type: 'usage'; usage: { percentage: number } }).usage;
      expect(usage.percentage).toBeCloseTo(0.08);
      expect(doneChunk).toEqual({ type: 'done' });
    });

    it('should emit error and done on turn.failed', async () => {
      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_007' },
          { type: 'turn.started' },
          { type: 'turn.failed', error: { message: 'Something went wrong' } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      expect(chunks).toContainEqual({ type: 'error', content: 'Something went wrong' });
      expect(chunks).toContainEqual({ type: 'done' });
    });
  });

  describe('query - image rejection', () => {
    it('should reject queries with images', async () => {
      const turn = createTurn();
      turn.request.images = [
        { id: 'img1', name: 'test.png', mediaType: 'image/png', data: 'abc', size: 100, source: 'file' },
      ];

      const chunks = await collectChunks(runtime.query(turn));
      expect(chunks).toContainEqual({ type: 'error', content: 'Codex does not support image attachments' });
      expect(chunks).toContainEqual({ type: 'done' });
    });
  });

  describe('query - thread options', () => {
    it('passes external context paths as additional directories', async () => {
      const turn = createTurn();
      turn.request.externalContextPaths = ['/external/a', '/external/b'];

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_dirs' },
          { type: 'turn.started' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(turn));

      expect(mockStartThread).toHaveBeenCalledWith(expect.objectContaining({
        additionalDirectories: ['/external/a', '/external/b'],
      }));
    });
  });

  describe('query - resumeThread', () => {
    it('should use resumeThread when a threadId is already set', async () => {
      runtime.syncConversationState({
        sessionId: 'thread_existing',
        providerState: {
          threadId: 'thread_existing',
          sessionFilePath: '/tmp/session.jsonl',
        },
      });

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'turn.started' },
          { type: 'item.started', item: { id: 'i1', type: 'agent_message', text: '' } },
          { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Resumed!' } },
          { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 10 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      const textChunks = chunks.filter(c => c.type === 'text');

      expect(mockResumeThread).toHaveBeenCalledWith('thread_existing', expect.any(Object));
      expect(mockStartThread).not.toHaveBeenCalled();
      expect(textChunks).toEqual([{ type: 'text', content: 'Resumed!' }]);
    });

    it('uses conversation.sessionId when providerState is absent', async () => {
      runtime.syncConversationState({
        sessionId: 'thread_from_session_id',
        providerState: undefined,
      });

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'turn.started' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(createTurn()));

      expect(mockResumeThread).toHaveBeenCalledWith('thread_from_session_id', expect.any(Object));
    });

    it('should use startThread when no threadId is set', async () => {
      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_new' },
          { type: 'turn.started' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(createTurn()));

      expect(mockStartThread).toHaveBeenCalled();
      expect(mockResumeThread).not.toHaveBeenCalled();
    });
  });

  describe('session management', () => {
    it('should capture thread ID from thread.started event', async () => {
      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_captured' },
          { type: 'turn.started' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(createTurn()));
      expect(runtime.getSessionId()).toBe('thread_captured');
    });

    it('should build session updates with thread ID', async () => {
      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_for_updates' },
          { type: 'turn.started' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(createTurn()));

      const result = runtime.buildSessionUpdates({
        conversation: null,
        sessionInvalidated: false,
      });

      expect(result.updates.sessionId).toBe('thread_for_updates');
      expect((result.updates.providerState as any).threadId).toBe('thread_for_updates');
    });

    it('should round-trip an existing session file path from provider state', () => {
      runtime.syncConversationState({
        sessionId: 'thread_persisted',
        providerState: {
          threadId: 'thread_persisted',
          sessionFilePath: '/tmp/codex-thread.jsonl',
        },
      });

      const result = runtime.buildSessionUpdates({
        conversation: null,
        sessionInvalidated: false,
      });

      expect((result.updates.providerState as any).sessionFilePath).toBe('/tmp/codex-thread.jsonl');
    });

    it('clears the previous transcript path when switching threads without a persisted path', () => {
      runtime.syncConversationState({
        sessionId: 'thread_a',
        providerState: {
          threadId: 'thread_a',
          sessionFilePath: '/tmp/thread-a.jsonl',
        },
      });

      runtime.syncConversationState({
        sessionId: 'thread_b',
        providerState: {
          threadId: 'thread_b',
        },
      });

      const result = runtime.buildSessionUpdates({
        conversation: null,
        sessionInvalidated: false,
      });

      expect(result.updates.sessionId).toBe('thread_b');
      expect(result.updates.providerState).toEqual({
        threadId: 'thread_b',
      });
    });

    it('clears provider state when the session is invalidated', () => {
      runtime.syncConversationState({
        sessionId: 'thread_invalidated',
        providerState: {
          threadId: 'thread_invalidated',
          sessionFilePath: '/tmp/thread-invalidated.jsonl',
        },
      });

      const result = runtime.buildSessionUpdates({
        conversation: {} as any,
        sessionInvalidated: true,
      });

      expect(result.updates.sessionId).toBeNull();
      expect(result.updates.providerState).toBeUndefined();
    });
  });
});
