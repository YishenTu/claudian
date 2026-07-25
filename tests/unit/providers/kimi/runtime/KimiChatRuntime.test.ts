import '@/providers';

import { JsonRpcErrorResponse } from '@/providers/acp';
import { KimiChatRuntime } from '@/providers/kimi/runtime/KimiChatRuntime';

function createMockPlugin(overrides: Record<string, unknown> = {}): any {
  const plugin: any = {
    app: {
      vault: {
        adapter: { basePath: '/tmp/claudian-kimi-vault' },
      },
    },
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/usr/local/bin/kimi'),
    manifest: { version: '0.0.0-test' },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    settings: {
      model: '',
      providerConfigs: {
        kimi: { enabled: true },
      },
    },
    ...overrides,
  };
  plugin.mutateSettings ??= jest.fn(async (mutation: (settings: any) => void | Promise<void>) => {
    await mutation(plugin.settings);
    await plugin.saveSettings();
  });
  return plugin;
}

describe('KimiChatRuntime', () => {
  it('rejects a second overlapping query without replacing the active route', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    (runtime as any).activeTurn = {
      cancelled: false,
      queue: { close: jest.fn(), next: jest.fn(), push: jest.fn() },
      sessionId: 'session-1',
    };

    const chunks: unknown[] = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'Second' }))) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'error', content: 'Kimi does not support overlapping turns.' },
      { type: 'done' },
    ]);
    expect((runtime as any).activeTurn.sessionId).toBe('session-1');
  });

  it('streams agent message chunks as text and closes with done', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-1' });
    (runtime as any).loadedSessionId = 'session-1';
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);
    (runtime as any).connection = {
      prompt: jest.fn(async ({ sessionId }: { sessionId: string }) => {
        await (runtime as any).handleSessionNotification({
          sessionId,
          update: {
            content: { text: 'Hello from Kimi', type: 'text' },
            messageId: 'assistant-1',
            sessionUpdate: 'agent_message_chunk',
          },
        });
        return { stopReason: 'end_turn' };
      }),
    };

    const chunks: unknown[] = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'Hi' }))) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({ content: 'Hello from Kimi', type: 'text' });
    expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
    expect(runtime.consumeTurnMetadata()).toEqual({ assistantMessageId: 'assistant-1' });
  });

  it('strips the kimi turn prefix from tool call ids before normalization', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-1' });
    (runtime as any).loadedSessionId = 'session-1';
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);
    (runtime as any).connection = {
      prompt: jest.fn(async ({ sessionId }: { sessionId: string }) => {
        await (runtime as any).handleSessionNotification({
          sessionId,
          update: {
            kind: 'other',
            rawInput: { command: 'ls' },
            sessionUpdate: 'tool_call',
            status: 'completed',
            title: 'Bash',
            toolCallId: '1b3bd402-e93c-4c4e-a6aa/tool-1',
          },
        });
        return { stopReason: 'end_turn' };
      }),
    };

    const chunks: unknown[] = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'Run ls' }))) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(expect.objectContaining({
      id: 'tool-1',
      type: 'tool_use',
    }));
    expect(JSON.stringify(chunks)).not.toContain('1b3bd402');
  });

  it('ignores notifications from a superseded ACP connection generation', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    const push = jest.fn();
    (runtime as any).sessionId = 'session-1';
    (runtime as any).connectionGeneration = 2;
    (runtime as any).activeTurn = {
      cancelled: false,
      queue: { close: jest.fn(), push },
      sessionId: 'session-1',
    };

    await (runtime as any).handleSessionNotification({
      sessionId: 'session-1',
      update: {
        content: { text: 'stale', type: 'text' },
        messageId: 'assistant-old',
        sessionUpdate: 'agent_message_chunk',
      },
    }, 1);

    expect(push).not.toHaveBeenCalled();
  });

  it('maps ACP permission options through the shared approval callback', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    const approvalCallback = jest.fn().mockResolvedValue('allow');
    runtime.setApprovalCallback(approvalCallback);
    const request = {
      options: [
        { kind: 'allow_once', name: 'Approve', optionId: 'approve' },
        { kind: 'allow_always', name: 'Approve for session', optionId: 'approve_for_session' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
      ],
      sessionId: 'session-1',
      toolCall: {
        kind: 'other',
        rawInput: { command: 'ls -la' },
        title: 'Bash: ls -la',
        toolCallId: 'tool-1',
      },
    };

    await expect((runtime as any).handlePermissionRequest(request)).resolves.toEqual({
      outcome: { optionId: 'approve', outcome: 'selected' },
    });
    expect(approvalCallback).toHaveBeenCalledWith(
      'Bash',
      { command: 'ls -la' },
      'Kimi wants to use Bash.',
      {
        decisionOptions: [
          { decision: 'allow', label: 'Approve', value: 'approve' },
          { decision: 'allow-always', label: 'Approve for session', value: 'approve_for_session' },
          { label: 'Reject', value: 'reject' },
        ],
      },
    );

    approvalCallback.mockResolvedValue('allow-always');
    await expect((runtime as any).handlePermissionRequest(request)).resolves.toEqual({
      outcome: { optionId: 'approve_for_session', outcome: 'selected' },
    });

    approvalCallback.mockResolvedValue('deny');
    await expect((runtime as any).handlePermissionRequest(request)).resolves.toEqual({
      outcome: { optionId: 'reject', outcome: 'selected' },
    });
  });

  it('cancels permission requests when no approval callback is installed', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());

    await expect((runtime as any).handlePermissionRequest({
      options: [{ kind: 'allow_once', name: 'Approve', optionId: 'approve' }],
      sessionId: 'session-1',
      toolCall: { title: 'Read', toolCallId: 'tool-1' },
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('surfaces ACP AUTH_REQUIRED with the terminal-auth command guidance', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);
    (runtime as any).connection = {
      newSession: jest.fn().mockRejectedValue(new JsonRpcErrorResponse(
        'session/new',
        -32000,
        'Authentication required',
        {
          authMethods: [{
            _meta: { 'terminal-auth': { args: ['login', '--browser'], command: 'kimi' } },
          }],
        },
      )),
    };

    const chunks: unknown[] = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'Hi' }))) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        type: 'error',
        content: 'Kimi requires authentication. '
          + 'Run `kimi login --browser` in a terminal to log in, then retry.',
      },
      { type: 'done' },
    ]);
  });

  it('falls back to kimi login guidance when AUTH_REQUIRED carries no metadata', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);
    (runtime as any).connection = {
      newSession: jest.fn().mockRejectedValue(
        new JsonRpcErrorResponse('session/new', -32000, 'Authentication required'),
      ),
    };

    const chunks: unknown[] = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'Hi' }))) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        type: 'error',
        content: 'Kimi requires authentication. '
          + 'Run `kimi login` in a terminal to log in, then retry.',
      },
      { type: 'done' },
    ]);
  });

  it('captures available ACP commands for the active session', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-1' });
    (runtime as any).loadedSessionId = 'session-1';

    const commandsPromise = runtime.discoverSupportedCommands(5_000);
    await (runtime as any).handleSessionNotification({
      sessionId: 'session-1',
      update: {
        availableCommands: [{ description: 'Review changes', name: 'review' }],
        sessionUpdate: 'available_commands_update',
      },
    });

    await expect(commandsPromise).resolves.toEqual([{
      content: '',
      description: 'Review changes',
      id: 'acp:review',
      name: 'review',
      source: 'sdk',
    }]);
  });

  it('rejects command waiters on malformed metadata, cleanup, and conversation changes', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-malformed' });
    (runtime as any).loadedSessionId = 'session-malformed';
    const malformedPromise = runtime.discoverSupportedCommands(5_000);

    await (runtime as any).handleSessionNotification({
      sessionId: 'session-malformed',
      update: { availableCommands: null, sessionUpdate: 'available_commands_update' },
    });
    await expect(malformedPromise).rejects.toThrow('Kimi sent malformed command metadata.');

    const cleanupPromise = runtime.discoverSupportedCommands(5_000);
    runtime.cleanup();
    await expect(cleanupPromise).rejects.toThrow('Kimi runtime stopped.');

    const restarted = new KimiChatRuntime(createMockPlugin());
    restarted.syncConversationState({ providerState: {}, sessionId: 'session-a' });
    const changePromise = restarted.discoverSupportedCommands(5_000);
    restarted.syncConversationState({ providerState: {}, sessionId: 'session-b' });
    await expect(changePromise).rejects.toThrow('Kimi command discovery context changed.');
  });
});
