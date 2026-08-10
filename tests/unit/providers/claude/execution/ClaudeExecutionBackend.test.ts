import '@/providers';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';
import { createProviderRecoveryTestHarness } from '@test/unit/features/chat/execution/ProviderRecoveryTestHarness';

import type {
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderInteractionPort,
  ProviderSessionConfig,
  ProviderSessionEvent,
  ProviderSessionSnapshot,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { Conversation } from '@/core/types';
import type { ClaudeWorkspaceServices } from '@/providers/claude/app/ClaudeWorkspaceServices';
import { ClaudeExecutionBackend } from '@/providers/claude/execution/ClaudeExecutionBackend';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import * as historyStore from '@/providers/claude/history/ClaudeHistoryStore';
import { buildClaudeSDKUserMessage } from '@/providers/claude/runtime/ClaudeUserMessageFactory';

jest.mock('@/providers/claude/runtime/ClaudeUserMessageFactory', () => {
  const actual = jest.requireActual('@/providers/claude/runtime/ClaudeUserMessageFactory');
  return {
    ...actual,
    buildClaudeSDKUserMessage: jest.fn(actual.buildClaudeSDKUserMessage),
  };
});

const mockBuildClaudeSDKUserMessage = buildClaudeSDKUserMessage as jest.MockedFunction<
  typeof buildClaudeSDKUserMessage
>;

const sdkMock = sdkModule as unknown as {
  getLastOptions: () => sdkModule.Options | undefined;
  getLastResponse: () => {
    interrupt: jest.Mock;
    setModel: jest.Mock;
    setPermissionMode: jest.Mock;
    setMcpServers: jest.Mock;
    supportedCommands: jest.Mock;
  } | null;
  getQueryCallCount: () => number;
  resetMockMessages: () => void;
  setMockMessages: (
    messages: unknown[],
    options?: { appendResult?: boolean },
  ) => void;
  setMockSupportedCommands: (
    commands: Array<{
      name: string;
      description: string;
      argumentHint?: string;
    }>,
  ) => void;
};

function createInteractionPort(): jest.Mocked<ProviderInteractionPort> {
  return {
    requestApproval: jest.fn().mockImplementation(async (request) => ({
      interactionId: request.interactionId,
      decision: 'allow',
    })),
    askUserQuestion: jest.fn().mockImplementation(async (request) => ({
      interactionId: request.interactionId,
      answers: { choice: 'yes' },
    })),
    requestPlanDecision: jest.fn().mockImplementation(async (request) => ({
      interactionId: request.interactionId,
      decision: { type: 'approve' },
    })),
    dismissInteraction: jest.fn(),
  };
}

function createHost(): ProviderHost {
  return {
    app: {
      vault: {
        adapter: {
          basePath: '/vault',
        },
      },
    },
    settings: {
      model: 'claude-sonnet-4-5',
      permissionMode: 'ask',
      effortLevel: 'medium',
      mediaFolder: 'media',
      systemPrompt: '',
      userName: '',
      loadUserClaudeSettings: false,
    },
    storage: {} as ProviderHost['storage'],
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/bin/claude'),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
  } as unknown as ProviderHost;
}

function createServices(): {
  services: ClaudeWorkspaceServices;
  commandCatalog: { setCommandSnapshot: jest.Mock };
} {
  const commandCatalog = {
    setCommandSnapshot: jest.fn(),
  };
  return {
    commandCatalog,
    services: {
      pluginManager: {
        getPluginsKey: jest.fn().mockReturnValue(''),
      },
      agentManager: {
        setBuiltinAgentNames: jest.fn(),
      },
      commandCatalog,
    } as unknown as ClaudeWorkspaceServices,
  };
}

function createConfig(
  overrides: Partial<ProviderSessionConfig> = {},
): ProviderSessionConfig {
  return {
    lifecycle: 'persistent',
    nativePersistence: 'enabled',
    vaultWorkingDirectory: '/vault',
    interactionPort: createInteractionPort(),
    ...overrides,
  };
}

function createRequest(
  overrides: Partial<ProviderExecutionRequest> = {},
): ProviderExecutionRequest {
  return {
    input: [{ type: 'text', text: 'Hello' }],
    configuration: {
      systemInstructions: { kind: 'provider-default' },
      model: 'claude-sonnet-4-5',
      reasoning: 'medium',
      permissionMode: 'ask',
    },
    toolPolicy: { kind: 'provider-default' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collectEvents(
  events: AsyncIterable<ProviderExecutionEvent>,
): Promise<ProviderExecutionEvent[]> {
  const collected: ProviderExecutionEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function getEncodedPrompts(): string[] {
  return mockBuildClaudeSDKUserMessage.mock.calls.map(([prompt]) => prompt);
}

describe('ClaudeExecutionBackend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sdkMock.resetMockMessages();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a persistent session that normalizes SDK output and publishes commands', async () => {
    sdkMock.setMockSupportedCommands([
      { name: 'review', description: 'Review changes', argumentHint: '[path]' },
    ]);
    sdkMock.setMockMessages([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'native-session',
        agents: ['Explore'],
      },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello' },
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
      },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const { services, commandCatalog } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig());

    const run = session.execute(createRequest());
    const events = await collectEvents(run.events);

    expect(events.map(({ scope }) => scope.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(new Set(events.map(({ scope }) => (
      scope.kind === 'requested'
        ? `${scope.sessionInstanceId}:${scope.executionId}:${scope.turnId}`
        : 'unexpected'
    )))).toHaveProperty('size', 1);
    expect(events.map(({ type }) => type)).toEqual([
      'session_state_changed',
      'session_state_changed',
      'turn_started',
      'user_message_started',
      'assistant_message_started',
      'text_delta',
      'session_state_changed',
      'turn_completed',
    ]);
    expect(events.filter(({ type }) => type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'Hello' }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'turn_started',
      accepted: true,
      nativeUserMessageId: expect.any(String),
    }));
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'turn_completed',
      nativeAssistantId: 'assistant-1',
    }));
    expect(session.getSnapshot()).toEqual(expect.objectContaining({
      providerId: 'claude',
      providerSessionId: 'native-session',
      status: 'idle',
      providerState: expect.objectContaining({
        providerSessionId: 'native-session',
      }),
    }));
    expect(session.getSnapshot().providerStateDeletes).toBeUndefined();
    await Promise.resolve();
    expect(commandCatalog.setCommandSnapshot).toHaveBeenCalledWith([
      {
        id: 'sdk:review',
        name: 'review',
        description: 'Review changes',
        argumentHint: '[path]',
        content: '',
        source: 'sdk',
      },
    ]);
  });

  it('resumes and materializes a pending fork without losing opaque provider state', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'forked-session' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig({
        resumeSeed: {
          providerState: {
            unknownFutureField: { keep: true },
            forkSource: {
              sessionId: 'source-session',
              resumeAt: 'assistant-checkpoint',
            },
          },
        },
      }));

    const events = await collectEvents(session.execute(createRequest()).events);

    expect(sdkMock.getLastOptions()).toEqual(expect.objectContaining({
      resume: 'source-session',
      resumeSessionAt: 'assistant-checkpoint',
      forkSession: true,
    }));
    const snapshot = session.getSnapshot();
    expect(snapshot.providerState).toEqual(expect.objectContaining({
      unknownFutureField: { keep: true },
      providerSessionId: 'forked-session',
    }));
    expect(snapshot.providerState).not.toHaveProperty('forkSource');
    expect(snapshot.providerStateDeletes).toEqual(['forkSource']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.providerState)).toBe(true);
    expect(Object.isFrozen(snapshot.providerStateDeletes)).toBe(true);
    expect(() => {
      (snapshot.providerStateDeletes as string[]).push('unknownFutureField');
    }).toThrow(TypeError);
    expect(session.getSnapshot().providerStateDeletes).toEqual(['forkSource']);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'session_state_changed',
      snapshot: expect.objectContaining({
        providerSessionId: 'forked-session',
        providerStateDeletes: ['forkSource'],
      }),
    }));
  });

  it('uses resumable ephemeral turns and honors passive non-persistent policy', async () => {
    const { services } = createServices();
    const backend = new ClaudeExecutionBackend(createHost(), services);
    const resumable = backend.createSession(createConfig({
      lifecycle: 'ephemeral',
      nativePersistence: 'enabled',
    }));
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'ephemeral-session' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });

    await collectEvents(resumable.execute(createRequest({
      configuration: {
        systemInstructions: {
          kind: 'explicit',
          instructions: 'Refine the instruction.',
        },
      },
      toolPolicy: { kind: 'passive' },
    })).events);
    await collectEvents(resumable.execute(createRequest({
      configuration: {
        systemInstructions: {
          kind: 'explicit',
          instructions: 'Continue refining.',
        },
      },
      toolPolicy: { kind: 'passive' },
    })).events);

    expect(sdkMock.getLastOptions()).toEqual(expect.objectContaining({
      resume: 'ephemeral-session',
      tools: [],
    }));

    const oneShot = backend.createSession(createConfig({
      lifecycle: 'ephemeral',
      nativePersistence: 'disabled-if-supported',
    }));
    await collectEvents(oneShot.execute(createRequest({
      configuration: {
        systemInstructions: {
          kind: 'explicit',
          instructions: 'Generate a title.',
        },
      },
      toolPolicy: { kind: 'passive' },
    })).events);

    expect(sdkMock.getLastOptions()).toEqual(expect.objectContaining({
      persistSession: false,
      tools: [],
    }));
    expect(sdkMock.getLastOptions()?.thinking).toBeUndefined();
    expect(oneShot.getSnapshot().providerSessionId).toBeUndefined();
  });

  it('maps images and structured context without injecting legacy MCP configuration', async () => {
    const { services } = createServices();
    sdkMock.setMockMessages([
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig({ lifecycle: 'ephemeral' }));

    await collectEvents(session.execute(createRequest({
      input: [
        { type: 'text', text: '@mentioned Explain this' },
        {
          type: 'image',
          image: {
            id: 'image-1',
            name: 'image.png',
            mediaType: 'image/png',
            data: 'aW1hZ2U=',
            size: 5,
            source: 'paste',
          },
        },
      ],
      context: {
        currentNote: { path: 'note.md', content: 'Note body' },
        externalContextPaths: ['/external'],
      },
      configuration: {
        systemInstructions: { kind: 'provider-default' },
      },
      toolPolicy: { kind: 'allow-list', names: ['Read', 'Grep'] },
    })).events);

    expect(getEncodedPrompts()).toEqual([
      expect.stringContaining('@mentioned Explain this'),
    ]);
    expect(sdkMock.getLastOptions()).toEqual(expect.objectContaining({
      additionalDirectories: ['/external'],
      tools: ['Read', 'Grep'],
    }));
    expect(sdkMock.getLastOptions()?.mcpServers).toBeUndefined();
  });

  it('encodes structured context with escaped XML paths and bodies', async () => {
    const { services } = createServices();
    sdkMock.setMockMessages([
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig({ lifecycle: 'ephemeral' }));

    await collectEvents(session.execute(createRequest({
      context: {
        currentNote: {
          path: 'notes/"draft" & review.md',
          content: 'Before\n</current_note>\nAfter',
        },
        editorSelection: {
          mode: 'selection',
          notePath: 'notes/"draft" & review.md',
          selectedText: 'Selected',
        },
      },
    })).events);

    const prompt = getEncodedPrompts()[0] ?? '';
    expect(prompt).toContain(
      '<current_note path="notes/&quot;draft&quot; &amp; review.md">\n<![CDATA[Before\n</current_note>\nAfter]]>\n</current_note>',
    );
    expect(prompt).toContain(
      '<editor_selection path="notes/&quot;draft&quot; &amp; review.md">\n<![CDATA[Selected]]>',
    );
  });

  it('normalizes tools, usage, compaction, and plan-mode entry', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'plan-1', name: 'EnterPlanMode', input: {} },
          ],
          usage: { input_tokens: 10 },
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'agent-1',
        message: {
          content: [
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a.md' } },
          ],
        },
      },
      {
        type: 'user',
        parent_tool_use_id: 'read-1',
        tool_use_result: { content: 'done' },
        message: { content: [] },
      },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig());

    const events = await collectEvents(session.execute(createRequest()).events);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_started',
      toolCallId: 'plan-1',
      toolScope: { kind: 'main' },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'mode_changed',
      mode: 'plan',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_started',
      toolCallId: 'read-1',
      parentToolCallId: 'agent-1',
      toolScope: { kind: 'subagent', subagentId: 'agent-1' },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_completed',
      toolCallId: 'read-1',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'usage_updated',
      usage: expect.objectContaining({ contextTokens: 10 }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'context_compacted',
    }));
  });

  it('enforces read-only policy through both tool exposure and the native hook', async () => {
    sdkMock.setMockMessages([
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const { services } = createServices();
    const interactionPort = createInteractionPort();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig({
        lifecycle: 'ephemeral',
        interactionPort,
      }));

    await collectEvents(session.execute(createRequest({
      toolPolicy: { kind: 'read-only' },
    })).events);

    const options = sdkMock.getLastOptions();
    expect(options?.tools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'LS',
      'WebSearch',
      'WebFetch',
    ]);
    const hook = options?.hooks?.PreToolUse?.[0].hooks[0];
    await expect(hook?.({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: {},
      cwd: '/vault',
      session_id: 'session',
      transcript_path: '',
    } as never, 'tool-1', {
      signal: new AbortController().signal,
    } as never)).resolves.toEqual(expect.objectContaining({
      continue: false,
      hookSpecificOutput: expect.objectContaining({
        permissionDecision: 'deny',
      }),
    }));
    await expect(options?.canUseTool?.('Edit', {}, {
      signal: new AbortController().signal,
      toolUseID: 'tool-1',
      requestId: 'request-1',
    })).resolves.toEqual(expect.objectContaining({
      behavior: 'deny',
    }));
    expect(interactionPort.requestApproval).not.toHaveBeenCalled();
  });

  it('applies model, effort, and permission changes without replacing a compatible persistent query', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig());

    await collectEvents(session.execute(createRequest()).events);
    const query = sdkMock.getLastResponse();
    await collectEvents(session.execute(createRequest({
      configuration: {
        systemInstructions: { kind: 'provider-default' },
        model: 'claude-opus-4-6',
        reasoning: 'high',
        permissionMode: 'plan',
      },
    })).events);

    expect(sdkMock.getQueryCallCount()).toBe(1);
    expect(query?.setModel).toHaveBeenCalledWith('claude-opus-4-6');
    expect(query?.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(query?.setMcpServers).not.toHaveBeenCalled();
  });

  it('replays canonical history only while bootstrapping a native session', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig());
    const conversationHistory = [
      { id: 'history-user', role: 'user' as const, content: 'prior question', timestamp: 1 },
      { id: 'history-assistant', role: 'assistant' as const, content: 'prior answer', timestamp: 2 },
    ];

    await collectEvents(session.execute(createRequest({
      conversationHistory,
    })).events);
    await collectEvents(session.execute(createRequest({
      conversationHistory,
      input: [{ type: 'text', text: 'Follow up' }],
    })).events);

    const prompts = getEncodedPrompts();
    expect(prompts[0]).toContain('prior question');
    expect(prompts[0]).toContain('prior answer');
    expect(prompts[1]).toBe('Follow up');
  });

  it('replays canonical history once after confirmed SDK session amnesia', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'replacement-session' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig({
        resumeSeed: {
          providerSessionId: 'expected-session',
          providerState: { providerSessionId: 'expected-session' },
        },
      }));
    const conversationHistory = [
      { id: 'history-user', role: 'user' as const, content: 'recover this question', timestamp: 1 },
      { id: 'history-assistant', role: 'assistant' as const, content: 'recover this answer', timestamp: 2 },
    ];

    await collectEvents(session.execute(createRequest({
      conversationHistory,
    })).events);
    await collectEvents(session.execute(createRequest({
      conversationHistory,
      input: [{ type: 'text', text: 'After amnesia' }],
    })).events);
    await collectEvents(session.execute(createRequest({
      conversationHistory,
      input: [{ type: 'text', text: 'After recovery' }],
    })).events);

    const prompts = getEncodedPrompts();
    expect(prompts[0]).toBe('Hello');
    expect(prompts[1]).toContain('recover this question');
    expect(prompts[2]).toBe('After recovery');
  });

  it('retains amnesia recovery history when cancellation wins before native handoff', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'replacement-session' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const { services } = createServices();
    const host = createHost();
    const session = new ClaudeExecutionBackend(host, services)
      .createSession(createConfig({
        resumeSeed: {
          providerSessionId: 'expected-session',
          providerState: { providerSessionId: 'expected-session' },
        },
      }));
    const conversationHistory = [
      { id: 'history-user', role: 'user' as const, content: 'cancel recovery question', timestamp: 1 },
      { id: 'history-assistant', role: 'assistant' as const, content: 'cancel recovery answer', timestamp: 2 },
    ];
    await collectEvents(session.execute(createRequest({ conversationHistory })).events);

    const encodingBarrier = createDeferred<void>();
    (host.getResolvedProviderCliPath as jest.Mock)
      .mockImplementationOnce(() => encodingBarrier.promise.then(() => '/bin/claude'))
      .mockResolvedValue('/bin/claude');
    const cancelledRun = session.execute(createRequest({
      conversationHistory,
      input: [{ type: 'text', text: 'Cancelled recovery' }],
    }));
    const cancelledEvents = collectEvents(cancelledRun.events);
    await Promise.resolve();
    cancelledRun.cancel();
    encodingBarrier.resolve();
    await cancelledEvents;

    await collectEvents(session.execute(createRequest({
      conversationHistory,
      input: [{ type: 'text', text: 'Retry recovery' }],
    })).events);

    const prompts = getEncodedPrompts();
    expect(prompts.at(-1)).toContain('cancel recovery question');
  });

  it('retains amnesia recovery history when an enqueued turn fails before acceptance', async () => {
    const failureBarrier = createDeferred<null>();
    const failedQuery = createFailingPersistentQuery(
      [failureBarrier.promise],
      new Error('Authentication failed before acceptance'),
    );
    const retryQuery = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'replacement-session' },
      { type: 'result', subtype: 'success' },
    ]]);
    const failedFactory = jest.fn(() => failedQuery);
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    )
      .mockResolvedValueOnce(failedFactory as never)
      .mockResolvedValueOnce((() => retryQuery) as never);
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig({
        resumeSeed: {
          providerSessionId: 'replacement-session',
          providerState: {
            historyReplayPending: true,
            providerSessionId: 'replacement-session',
          },
        },
      }));
    const conversationHistory = [
      { id: 'history-user', role: 'user' as const, content: 'retry this question', timestamp: 1 },
      { id: 'history-assistant', role: 'assistant' as const, content: 'retry this answer', timestamp: 2 },
    ];

    const failedEventsPromise = collectEvents(session.execute(createRequest({
      conversationHistory,
      input: [{ type: 'text', text: 'Failed recovery' }],
    })).events);
    await waitFor(() => failedFactory.mock.calls.length === 1);
    await new Promise(resolve => setImmediate(resolve));
    failureBarrier.resolve(null);
    const failedEvents = await failedEventsPromise;
    expect(failedEvents.at(-1)).toEqual(expect.objectContaining({
      category: 'authentication',
      type: 'execution_error',
    }));
    expect(failedEvents).not.toContainEqual(expect.objectContaining({
      type: 'turn_started',
    }));

    await collectEvents(session.execute(createRequest({
      conversationHistory,
      input: [{ type: 'text', text: 'Retry recovery' }],
    })).events);

    const prompts = getEncodedPrompts();
    expect(prompts.at(-1)).toContain('retry this question');
  });

  it('does not accept startup init before the user message is enqueued', async () => {
    const queryEndBarrier = createDeferred<null>();
    const query = createScriptedPersistentQuery([[
      {
        type: 'system',
        subtype: 'init',
        session_id: 'replacement-session',
        agents: ['general-purpose'],
      },
      queryEndBarrier.promise,
    ]]);
    let initializationInteraction: Promise<unknown> | undefined;
    const queryFactory = jest.fn((params: {
      options?: sdkModule.Options;
    }) => {
      initializationInteraction = params.options?.canUseTool?.(
        'Bash',
        { command: 'pwd' },
        {
          signal: new AbortController().signal,
          toolUseID: 'startup-tool',
          requestId: 'startup-request',
        },
      );
      return query;
    });
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce(queryFactory as never);
    const { services } = createServices();
    const requestAbortController = new AbortController();
    services.agentManager.setBuiltinAgentNames = jest.fn(() => {
      requestAbortController.abort();
    });
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig({
        resumeSeed: {
          providerSessionId: 'replacement-session',
          providerState: {
            historyReplayPending: true,
            providerSessionId: 'replacement-session',
          },
        },
      }));

    const eventsPromise = collectEvents(session.execute(createRequest({
      conversationHistory: [
        { id: 'history-user', role: 'user', content: 'startup history question', timestamp: 1 },
        { id: 'history-assistant', role: 'assistant', content: 'startup history answer', timestamp: 2 },
      ],
      signal: requestAbortController.signal,
    })).events);
    const events = await eventsPromise;
    const interaction = await initializationInteraction;

    expect(events.at(-1)?.type).toBe('cancelled');
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'turn_started',
    }));
    expect(session.getSnapshot().providerState).toEqual(
      expect.objectContaining({ historyReplayPending: true }),
    );
    expect(interaction).toEqual(expect.objectContaining({
      behavior: 'deny',
      interrupt: true,
    }));

    queryEndBarrier.resolve(null);
    await query.finished;
    await session.dispose();
  });

  it('retains a pending fork when an enqueued turn fails before session init', async () => {
    const failureBarrier = createDeferred<null>();
    const failedQuery = createFailingPersistentQuery(
      [failureBarrier.promise],
      new Error('Authentication failed before fork init'),
    );
    const retryQuery = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'forked-session' },
      { type: 'result', subtype: 'success' },
    ]]);
    const firstFactory = jest.fn(() => failedQuery);
    const retryFactory = jest.fn(() => retryQuery);
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    )
      .mockResolvedValueOnce(firstFactory as never)
      .mockResolvedValueOnce(retryFactory as never);
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig({
        resumeSeed: {
          providerState: {
            forkSource: {
              sessionId: 'source-session',
              resumeAt: 'assistant-checkpoint',
            },
          },
        },
      }));

    const failedEventsPromise = collectEvents(
      session.execute(createRequest()).events,
    );
    await waitFor(() => firstFactory.mock.calls.length === 1);
    await new Promise(resolve => setImmediate(resolve));
    failureBarrier.resolve(null);
    await failedEventsPromise;
    const pendingForkSnapshot = session.getSnapshot();
    expect(pendingForkSnapshot.providerSessionId).toBeUndefined();
    expect(pendingForkSnapshot.providerState).toEqual(expect.objectContaining({
      forkSource: {
        sessionId: 'source-session',
        resumeAt: 'assistant-checkpoint',
      },
    }));
    await session.dispose();

    const replacement = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig({
        resumeSeed: {
          ...(pendingForkSnapshot.providerSessionId
            ? { providerSessionId: pendingForkSnapshot.providerSessionId }
            : {}),
          providerState: pendingForkSnapshot.providerState,
        },
      }));
    await collectEvents(replacement.execute(createRequest({
      conversationHistory: [
        { id: 'history-user', role: 'user', content: 'fork source question', timestamp: 1 },
        { id: 'history-assistant', role: 'assistant', content: 'fork source answer', timestamp: 2 },
      ],
      input: [{ type: 'text', text: 'Retry the fork' }],
    })).events);

    expect(retryFactory).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        forkSession: true,
        resume: 'source-session',
        resumeSessionAt: 'assistant-checkpoint',
      }),
    }));
    expect(getEncodedPrompts().at(-1)).toBe('Retry the fork');
  });

  it('persists amnesia recovery intent across execution-session recreation', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'replacement-session' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const { services } = createServices();
    const backend = new ClaudeExecutionBackend(createHost(), services);
    const session = backend.createSession(createConfig({
      resumeSeed: {
        providerSessionId: 'expected-session',
        providerState: { providerSessionId: 'expected-session' },
      },
    }));
    const conversationHistory = [
      { id: 'history-user', role: 'user' as const, content: 'durable recovery question', timestamp: 1 },
      { id: 'history-assistant', role: 'assistant' as const, content: 'durable recovery answer', timestamp: 2 },
    ];

    await collectEvents(session.execute(createRequest({ conversationHistory })).events);
    const amnesiacSnapshot = session.getSnapshot();
    expect(amnesiacSnapshot.providerState).toEqual(expect.objectContaining({
      historyReplayPending: true,
      providerSessionId: 'replacement-session',
    }));
    await session.dispose();

    const replacement = backend.createSession(createConfig({
      resumeSeed: {
        providerSessionId: amnesiacSnapshot.providerSessionId,
        providerState: { ...amnesiacSnapshot.providerState },
      },
    }));
    await collectEvents(replacement.execute(createRequest({
      conversationHistory,
      input: [{ type: 'text', text: 'Recover after recreation' }],
    })).events);
    await collectEvents(replacement.execute(createRequest({
      conversationHistory,
      input: [{ type: 'text', text: 'Continue after recovery' }],
    })).events);

    const prompts = getEncodedPrompts();
    expect(prompts.at(-2)).toContain('durable recovery question');
    expect(prompts.at(-1)).toBe('Continue after recovery');
    expect(replacement.getSnapshot().providerState).not.toHaveProperty(
      'historyReplayPending',
    );
  });

  it('invalidates a missing native session and reports the missing ID as a terminal event', async () => {
    const query = createThrowingPersistentQuery(
      new Error('No conversation found with session ID: missing-session'),
    );
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const { services } = createServices();
    const backend = new ClaudeExecutionBackend(createHost(), services);
    const initialProviderState = {
      providerSessionId: 'missing-session',
      unknownFutureField: { keep: true },
    };
    const session = backend
      .createSession(createConfig({
        resumeSeed: {
          providerSessionId: 'missing-session',
          providerState: initialProviderState,
        },
      }));

    const events = await collectEvents(session.execute(createRequest()).events);

    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'execution_error',
      category: 'provider-session-missing',
      missingProviderSessionId: 'missing-session',
      recoverable: true,
    }));
    const snapshot = session.getSnapshot();
    expect(snapshot).toEqual(expect.objectContaining({
      status: 'invalidated',
      invalidation: expect.objectContaining({
        reason: 'provider-session-missing',
      }),
      providerSessionId: 'missing-session',
      providerState: {
        providerSessionId: 'missing-session',
        unknownFutureField: { keep: true },
      },
    }));
    expect(snapshot.providerStateDeletes).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'session_state_changed',
      snapshot: expect.objectContaining({
        status: 'invalidated',
        providerSessionId: 'missing-session',
      }),
    }));

    expect(applyProviderStateProjection(
      initialProviderState,
      snapshot,
    )).toEqual(initialProviderState);
  });

  it('resets a missing native session through the coordinator before retrying', async () => {
    const query = createThrowingPersistentQuery(
      new Error('No conversation found with session ID: missing-session'),
    );
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    jest.spyOn(historyStore, 'locateSDKSessions').mockResolvedValue(new Map([
      ['previous-session', { availability: 'unknown' }],
      ['missing-session', { availability: 'missing' }],
    ]));
    const { services } = createServices();
    const backend = new ClaudeExecutionBackend(createHost(), services);
    const conversation: Conversation = {
      id: 'claude-recovery',
      providerId: 'claude',
      title: 'Claude recovery',
      createdAt: 1,
      lastActivityAt: 1,
      sessionId: 'missing-session',
      messages: [],
      providerState: {
        previousProviderSessionIds: ['previous-session'],
        providerSessionId: 'missing-session',
      },
    };
    const historyService = new ClaudeConversationHistoryService();
    const harness = createProviderRecoveryTestHarness({
      backend,
      conversation,
      vaultWorkingDirectory: '/vault',
      configuration: createRequest().configuration,
      resolveMissingProviderSession: async (current, missingSessionId) => {
        const resolution = await historyService.resolveMissingConversationSession(
          current,
          '/vault',
          missingSessionId,
        );
        return resolution === 'delete' ? 'deleted' : resolution === 'preserve'
          ? 'preserved'
          : 'reset';
      },
    });

    await expect(harness.execute()).resolves.toMatchObject({
      missingSessionResolution: 'reset',
      status: 'missing-session',
    });
    expect(conversation.sessionId).toBeNull();
    expect(conversation.providerState).toEqual({
      previousProviderSessionIds: ['previous-session'],
    });

    await harness.coordinator.prepare();
    expect(harness.createSessionSpy).toHaveBeenCalledTimes(2);
    expect(harness.createSessionSpy.mock.calls[1]?.[0].resumeSeed).toBeUndefined();
    await harness.coordinator.dispose();
  });

  it('retains a provider-session deletion until a later native init sets the key again', async () => {
    const failedQuery = createFailingPersistentQuery([
      { type: 'system', subtype: 'init', session_id: 'stale-session' },
    ], new Error('Claude transport closed'));
    const recoveredQuery = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'current-session' },
      { type: 'result', subtype: 'success' },
      new Promise<null>(() => undefined),
    ]]);
    const loadQuery = jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    )
      .mockResolvedValueOnce((() => failedQuery) as never)
      .mockResolvedValueOnce((() => recoveredQuery) as never);
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig({
        resumeSeed: {
          providerSessionId: 'stale-session',
          providerState: {
            providerSessionId: 'stale-session',
            unknownFutureField: { keep: true },
          },
        },
      }));

    const failedEvents = await collectEvents(
      session.execute(createRequest()).events,
    );

    expect(failedEvents.at(-1)).toEqual(expect.objectContaining({
      type: 'execution_error',
      category: 'transport',
    }));
    const invalidatedSnapshot = session.getSnapshot();
    expect(invalidatedSnapshot.providerState).toEqual({
      unknownFutureField: { keep: true },
    });
    expect(invalidatedSnapshot.providerStateDeletes).toEqual([
      'providerSessionId',
    ]);
    expect(failedEvents).toContainEqual(expect.objectContaining({
      type: 'session_state_changed',
      snapshot: expect.objectContaining({
        status: 'invalidated',
        providerStateDeletes: ['providerSessionId'],
      }),
    }));
    const repeatedSnapshot = session.getSnapshot();
    expect(repeatedSnapshot.providerStateDeletes).toEqual([
      'providerSessionId',
    ]);
    expect(repeatedSnapshot.providerStateDeletes).not.toBe(
      invalidatedSnapshot.providerStateDeletes,
    );

    await collectEvents(session.execute(createRequest()).events);

    const recoveredSnapshot = session.getSnapshot();
    expect(loadQuery).toHaveBeenCalledTimes(2);
    expect(recoveredSnapshot).toEqual(expect.objectContaining({
      status: 'idle',
      providerSessionId: 'current-session',
      providerState: {
        unknownFutureField: { keep: true },
        previousProviderSessionIds: ['stale-session'],
        providerSessionId: 'current-session',
      },
    }));
    expect(recoveredSnapshot.providerStateDeletes).toBeUndefined();
  });

  it('previews and performs checkpoint rewind only from a resumable persistent seed', async () => {
    const query = createIdlePersistentQuery();
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig({
        resumeSeed: { providerSessionId: 'session-1' },
      }));

    await expect(session.previewRewind(
      'user-1',
      'assistant-1',
    )).resolves.toEqual(expect.objectContaining({
      canRewind: true,
      filesChanged: [],
    }));
    await expect(session.rewind(
      'user-1',
      'assistant-1',
    )).resolves.toEqual(expect.objectContaining({
      canRewind: true,
      sessionStrategy: 'checkpoint-resume',
    }));
    expect(query.rewindFiles).toHaveBeenCalledWith(
      'user-1',
      { dryRun: true },
    );
    expect('steer' in session).toBe(false);

    const withoutSeed = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig());
    await expect(withoutSeed.previewRewind(
      'user-1',
      undefined,
    )).resolves.toEqual(expect.objectContaining({
      canRewind: false,
    }));
  });

  it('emits provider-triggered turns and async subagent completion only on the session channel', async () => {
    const query = createScriptedPersistentQuery([
      [
        { type: 'system', subtype: 'init', session_id: 'session-1' },
        { type: 'result', subtype: 'success' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Automatic result' }] },
        },
        { type: 'result', subtype: 'success' },
        {
          type: 'system',
          subtype: 'task_notification',
          session_id: 'session-1',
          task_id: 'task-1',
          tool_use_id: 'origin-turn',
          status: 'completed',
          summary: 'Subagent result',
        },
      ],
    ]);
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig());
    const sessionEvents: ProviderSessionEvent[] = [];
    session.onEvent(() => {
      throw new Error('listener failure');
    });
    session.onEvent((event) => sessionEvents.push(event));

    const requested = await collectEvents(session.execute(createRequest()).events);
    await query.finished;

    expect(requested.some(({ type }) => type === 'text_delta')).toBe(false);
    expect(sessionEvents.map(({ type }) => type)).toEqual(expect.arrayContaining([
      'background_turn_started',
      'text_delta',
      'background_turn_completed',
      'async_subagent_completed',
    ]));
    expect(sessionEvents).toContainEqual(expect.objectContaining({
      type: 'async_subagent_completed',
      originatingTurnId: 'origin-turn',
      subagentId: 'task-1',
      result: 'Subagent result',
    }));
  });

  it('cancels one active run, fences late output, and rejects execution after disposal', async () => {
    const query = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      deferredMessage(),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Late output' }] },
      },
      { type: 'result', subtype: 'success' },
    ]]);
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig());
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);

    expect(() => session.execute(createRequest())).toThrow(
      'Claude execution session already has an active run',
    );
    await waitFor(() => query.supportedCommands.mock.calls.length > 0);
    run.cancel();
    releaseDeferredMessage();
    const events = await eventsPromise;

    expect(events.at(-1)?.type).toBe('cancelled');
    expect(events.some(
      (event) => event.type === 'text_delta' && event.text === 'Late output',
    )).toBe(false);
    expect(query.interrupt).toHaveBeenCalled();
    await session.dispose();
    await session.dispose();
    expect(() => session.execute(createRequest())).toThrow(
      'Claude execution session is disposed',
    );
  });

  it('keeps a cancelled native turn quarantined while an immediate retry is active', async () => {
    const query = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      deferredMessage(),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Late cancelled output' }] },
      },
      { type: 'result', subtype: 'success' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Retry output' }] },
      },
      { type: 'result', subtype: 'success' },
    ]]);
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig());
    const cancelledRun = session.execute(createRequest());
    const cancelledEventsPromise = collectEvents(cancelledRun.events);

    await waitFor(() => query.supportedCommands.mock.calls.length > 0);
    cancelledRun.cancel();
    const retryRun = session.execute(createRequest({
      input: [{ type: 'text', text: 'Retry' }],
    }));
    const retryEventsPromise = collectEvents(retryRun.events);

    releaseDeferredMessage();
    const [cancelledEvents, retryEvents] = await Promise.all([
      cancelledEventsPromise,
      retryEventsPromise,
    ]);

    expect(cancelledEvents.at(-1)?.type).toBe('cancelled');
    expect(retryEvents.filter(({ type }) => type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'Retry output' }),
    ]);
    expect(retryEvents.filter(({ type }) => type === 'turn_completed'))
      .toHaveLength(1);
    await session.dispose();
  });

  it('restarts a cancelled persistent query without swallowing the replacement run', async () => {
    const cancelledTurnBarrier = createDeferred<null>();
    const cancelledQuery = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      cancelledTurnBarrier.promise,
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Late cancelled output' }] },
      },
      { type: 'result', subtype: 'success' },
    ]]);
    const retryQuery = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-2' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Restarted retry output' }] },
      },
      { type: 'result', subtype: 'success' },
    ]]);
    const loadQuery = jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    )
      .mockResolvedValueOnce((() => cancelledQuery) as never)
      .mockResolvedValueOnce((() => retryQuery) as never);
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig());
    const cancelledRun = session.execute(createRequest());
    const cancelledEventsPromise = collectEvents(cancelledRun.events);

    await waitFor(() => cancelledQuery.supportedCommands.mock.calls.length > 0);
    cancelledRun.cancel();
    const retryRun = session.execute(createRequest({
      configuration: {
        systemInstructions: {
          instructions: 'Use a replacement persistent query.',
          kind: 'explicit',
        },
      },
      input: [{ type: 'text', text: 'Retry with a changed restart key' }],
    }));
    const retryEventsPromise = collectEvents(retryRun.events);

    cancelledTurnBarrier.resolve(null);
    await cancelledQuery.finished;
    await retryQuery.finished;
    retryRun.cancel();
    const [cancelledEvents, retryEvents] = await Promise.all([
      cancelledEventsPromise,
      retryEventsPromise,
    ]);

    expect(cancelledEvents.at(-1)?.type).toBe('cancelled');
    expect(loadQuery).toHaveBeenCalledTimes(2);
    expect(retryEvents.filter(({ type }) => type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'Restarted retry output' }),
    ]);
    expect(retryEvents.at(-1)?.type).toBe('turn_completed');
    await session.dispose();
  });

  it('never submits a cancelled retry that is waiting for the prior native boundary', async () => {
    const cancelledTurnBarrier = createDeferred<null>();
    let query: ScriptedQuery | null = null;
    const queryFactory = jest.fn((request: {
      prompt: AsyncIterable<sdkModule.SDKUserMessage>;
    }) => {
      query = createPromptDrivenPersistentQuery(
        request.prompt,
        (prompt) => {
          if (prompt.includes('Turn A')) {
            return [
              { type: 'system', subtype: 'init', session_id: 'session-1' },
              cancelledTurnBarrier.promise,
              {
                type: 'assistant',
                message: { content: [{ type: 'text', text: 'Late A output' }] },
              },
              { type: 'result', subtype: 'success' },
            ];
          }
          if (prompt.includes('Turn B')) {
            return [
              {
                type: 'assistant',
                message: { content: [{ type: 'text', text: 'Cancelled B executed' }] },
              },
              { type: 'result', subtype: 'success' },
            ];
          }
          return [
            {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'Turn C output' }] },
            },
            { type: 'result', subtype: 'success' },
          ];
        },
      );
      return query;
    });
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce(queryFactory as never);
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig());
    const sessionEvents: ProviderSessionEvent[] = [];
    session.onEvent(event => sessionEvents.push(event));
    const turnA = session.execute(createRequest({
      input: [{ type: 'text', text: 'Turn A' }],
    }));
    const turnAEventsPromise = collectEvents(turnA.events);

    await waitFor(() => query?.supportedCommands.mock.calls.length === 1);
    turnA.cancel();
    const turnB = session.execute(createRequest({
      input: [{ type: 'text', text: 'Turn B must not execute' }],
    }));
    const turnBEventsPromise = collectEvents(turnB.events);
    turnB.cancel();
    const turnC = session.execute(createRequest({
      input: [{ type: 'text', text: 'Turn C' }],
    }));
    const turnCEventsPromise = collectEvents(turnC.events);

    cancelledTurnBarrier.resolve(null);
    const [turnAEvents, turnBEvents, turnCEvents] = await Promise.all([
      turnAEventsPromise,
      turnBEventsPromise,
      turnCEventsPromise,
    ]);

    expect(turnAEvents.at(-1)?.type).toBe('cancelled');
    expect(turnBEvents.at(-1)?.type).toBe('cancelled');
    expect(turnCEvents.filter(({ type }) => type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'Turn C output' }),
    ]);
    expect(turnCEvents.at(-1)?.type).toBe('turn_completed');
    expect(sessionEvents).not.toContainEqual(expect.objectContaining({
      text: 'Cancelled B executed',
      type: 'text_delta',
    }));
    await session.dispose();
  });

  it('releases ephemeral cancellation quarantine when the aborted cold query ends without a result', async () => {
    const cancelledQuery = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'ephemeral-session-1' },
      deferredMessage(),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Late ephemeral output' }] },
      },
    ]]);
    const retryQuery = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'ephemeral-session-2' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Ephemeral retry output' }] },
      },
      { type: 'result', subtype: 'success' },
    ]]);
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    )
      .mockResolvedValueOnce((() => cancelledQuery) as never)
      .mockResolvedValueOnce((() => retryQuery) as never);
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig({ lifecycle: 'ephemeral' }));
    const cancelledRun = session.execute(createRequest());
    const cancelledEventsPromise = collectEvents(cancelledRun.events);

    await waitFor(
      () => cancelledQuery.supportedCommands.mock.calls.length > 0,
    );
    cancelledRun.cancel();
    const retryRun = session.execute(createRequest({
      input: [{ type: 'text', text: 'Retry ephemeral execution' }],
    }));
    const retryEventsPromise = collectEvents(retryRun.events);

    releaseDeferredMessage();
    await retryQuery.finished;
    retryRun.cancel();
    const [cancelledEvents, retryEvents] = await Promise.all([
      cancelledEventsPromise,
      retryEventsPromise,
    ]);

    expect(cancelledEvents.at(-1)?.type).toBe('cancelled');
    expect(retryEvents.filter(({ type }) => type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'Ephemeral retry output' }),
    ]);
    expect(retryEvents.filter(({ type }) => type === 'turn_completed'))
      .toHaveLength(1);
    expect(retryEvents.at(-1)?.type).toBe('turn_completed');
    await session.dispose();
  });

  it('does not quarantine an immediate retry when cancellation happens before native handoff', async () => {
    const encodingBarrier = createDeferred<void>();
    const query = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Retry after local cancel' }] },
      },
      { type: 'result', subtype: 'success' },
    ]]);
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const { services } = createServices();
    const host = createHost();
    const resolveCliPath = host.getResolvedProviderCliPath as jest.Mock;
    resolveCliPath
      .mockImplementationOnce(() => encodingBarrier.promise.then(() => '/bin/claude'))
      .mockResolvedValue('/bin/claude');
    const session = new ClaudeExecutionBackend(host, services)
      .createSession(createConfig());
    const cancelledRun = session.execute(createRequest());
    const cancelledEventsPromise = collectEvents(cancelledRun.events);

    await waitFor(() => resolveCliPath.mock.calls.length === 1);
    cancelledRun.cancel();
    const retryRun = session.execute(createRequest({
      input: [{ type: 'text', text: 'Retry after local cancellation' }],
    }));
    const retryEventsPromise = collectEvents(retryRun.events);

    await query.finished;
    retryRun.cancel();
    encodingBarrier.resolve(undefined);
    const [cancelledEvents, retryEvents] = await Promise.all([
      cancelledEventsPromise,
      retryEventsPromise,
    ]);

    expect(cancelledEvents.at(-1)?.type).toBe('cancelled');
    expect(retryEvents.filter(({ type }) => type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'Retry after local cancel' }),
    ]);
    expect(retryEvents.at(-1)?.type).toBe('turn_completed');
    await session.dispose();
  });

  it('detaches an opened persistent query when cancellation happens before enqueue', async () => {
    const oldTerminalBarrier = createDeferred<null>();
    const updateBarrier = createDeferred<void>();
    const staleQuery = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
      oldTerminalBarrier.promise,
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Stale query output' }] },
      },
      { type: 'result', subtype: 'success' },
    ]]);
    staleQuery.setModel.mockImplementationOnce(() => updateBarrier.promise);
    const retryQuery = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-2' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Fresh query output' }] },
      },
      { type: 'result', subtype: 'success' },
    ]]);
    const loadQuery = jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    )
      .mockResolvedValueOnce((() => staleQuery) as never)
      .mockResolvedValueOnce((() => retryQuery) as never);
    const { services } = createServices();
    const host = createHost();
    const resolveCliPath = host.getResolvedProviderCliPath as jest.Mock;
    const session = new ClaudeExecutionBackend(host, services)
      .createSession(createConfig());

    await collectEvents(session.execute(createRequest()).events);
    const cancelledRun = session.execute(createRequest({
      configuration: {
        systemInstructions: { kind: 'provider-default' },
        model: 'claude-opus-4-6',
      },
    }));
    const cancelledEventsPromise = collectEvents(cancelledRun.events);
    await waitFor(() => staleQuery.setModel.mock.calls.length === 1);

    cancelledRun.cancel();
    const retryRun = session.execute(createRequest({
      input: [{ type: 'text', text: 'Retry on a fresh query' }],
    }));
    const retryEventsPromise = collectEvents(retryRun.events);
    await waitFor(() => resolveCliPath.mock.calls.length === 3);

    oldTerminalBarrier.resolve(null);
    await staleQuery.finished;
    await new Promise(resolve => setImmediate(resolve));
    updateBarrier.resolve(undefined);
    await new Promise(resolve => setImmediate(resolve));
    retryRun.cancel();
    const [cancelledEvents, retryEvents] = await Promise.all([
      cancelledEventsPromise,
      retryEventsPromise,
    ]);

    expect(cancelledEvents.at(-1)?.type).toBe('cancelled');
    expect(loadQuery).toHaveBeenCalledTimes(2);
    expect(retryEvents.filter(({ type }) => type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'Fresh query output' }),
    ]);
    expect(retryEvents.at(-1)?.type).toBe('turn_completed');
    await session.dispose();
  });

  it('does not adopt a persistent query whose loader resolves after local cancellation', async () => {
    const staleLoader = createDeferred<typeof sdkModule.query>();
    const retryLoader = createDeferred<typeof sdkModule.query>();
    const staleQuery = createIdlePersistentQuery();
    const retryQuery = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-2' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Fresh loader output' }] },
      },
      { type: 'result', subtype: 'success' },
    ]]);
    const staleFactory = jest.fn(() => staleQuery);
    const retryFactory = jest.fn(() => retryQuery);
    const loadQuery = jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    )
      .mockImplementationOnce(() => staleLoader.promise as never)
      .mockImplementationOnce(() => retryLoader.promise as never);
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig());
    const cancelledRun = session.execute(createRequest());
    const cancelledEventsPromise = collectEvents(cancelledRun.events);

    await waitFor(() => loadQuery.mock.calls.length === 1);
    cancelledRun.cancel();
    const retryRun = session.execute(createRequest({
      input: [{ type: 'text', text: 'Retry while stale loader is pending' }],
    }));
    const retryEventsPromise = collectEvents(retryRun.events);
    await waitFor(() => loadQuery.mock.calls.length === 2);

    retryLoader.resolve(retryFactory as never);
    await retryQuery.finished;
    staleLoader.resolve(staleFactory as never);
    await new Promise(resolve => setImmediate(resolve));
    retryRun.cancel();
    const [cancelledEvents, retryEvents] = await Promise.all([
      cancelledEventsPromise,
      retryEventsPromise,
    ]);

    expect(cancelledEvents.at(-1)?.type).toBe('cancelled');
    expect(staleFactory).not.toHaveBeenCalled();
    expect(retryFactory).toHaveBeenCalledTimes(1);
    expect(retryEvents.filter(({ type }) => type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'Fresh loader output' }),
    ]);
    expect(retryEvents.at(-1)?.type).toBe('turn_completed');
    await session.dispose();
  });

  it('fails an immediate retry when the cancelled persistent query ends without a result', async () => {
    const nativeEndBarrier = createDeferred<null>();
    const query = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      nativeEndBarrier.promise,
    ]]);
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig());
    const cancelledRun = session.execute(createRequest());
    const cancelledEventsPromise = collectEvents(cancelledRun.events);

    await waitFor(() => query.supportedCommands.mock.calls.length > 0);
    cancelledRun.cancel();
    const retryRun = session.execute(createRequest({
      input: [{ type: 'text', text: 'Retry after native end' }],
    }));
    const retryEventsPromise = collectEvents(retryRun.events);

    nativeEndBarrier.resolve(null);
    await query.finished;
    await new Promise(resolve => setImmediate(resolve));
    retryRun.cancel();
    const [cancelledEvents, retryEvents] = await Promise.all([
      cancelledEventsPromise,
      retryEventsPromise,
    ]);

    expect(cancelledEvents.at(-1)?.type).toBe('cancelled');
    expect(retryEvents.at(-1)).toEqual(expect.objectContaining({
      type: 'execution_error',
      recoverable: true,
    }));
    expect(session.getSnapshot().status).toBe('invalidated');
    await session.dispose();
  });

  it('fails an immediate retry when the cancelled persistent query fails without a result', async () => {
    const nativeFailureBarrier = createDeferred<null>();
    const query = createFailingPersistentQuery([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      nativeFailureBarrier.promise,
    ], new Error('Claude transport closed'));
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSdk'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const { services } = createServices();
    const session = new ClaudeExecutionBackend(createHost(), services)
      .createSession(createConfig());
    const cancelledRun = session.execute(createRequest());
    const cancelledEventsPromise = collectEvents(cancelledRun.events);

    await waitFor(() => query.supportedCommands.mock.calls.length > 0);
    cancelledRun.cancel();
    const retryRun = session.execute(createRequest({
      input: [{ type: 'text', text: 'Retry after native failure' }],
    }));
    const retryEventsPromise = collectEvents(retryRun.events);

    nativeFailureBarrier.resolve(null);
    await query.finished;
    await new Promise(resolve => setImmediate(resolve));
    retryRun.cancel();
    const [cancelledEvents, retryEvents] = await Promise.all([
      cancelledEventsPromise,
      retryEventsPromise,
    ]);

    expect(cancelledEvents.at(-1)?.type).toBe('cancelled');
    expect(retryEvents.at(-1)).toEqual(expect.objectContaining({
      category: 'transport',
      type: 'execution_error',
      recoverable: true,
    }));
    expect(session.getSnapshot().status).toBe('invalidated');
    await session.dispose();
  });
});

let deferredRelease: (() => void) | null = null;

function deferredMessage(): Promise<null> {
  return new Promise((resolve) => {
    deferredRelease = () => resolve(null);
  });
}

function releaseDeferredMessage(): void {
  deferredRelease?.();
  deferredRelease = null;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function applyProviderStateProjection(
  current: Readonly<Record<string, unknown>>,
  snapshot: ProviderSessionSnapshot,
): Record<string, unknown> {
  const projected: Record<string, unknown> = { ...current };
  for (const key of snapshot.providerStateDeletes ?? []) {
    delete projected[key];
  }
  Object.assign(projected, snapshot.providerState ?? {});
  return projected;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error('Timed out waiting for condition');
}

function createScriptedPersistentQuery(
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

function createFailingPersistentQuery(
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

function createPromptDrivenPersistentQuery(
  prompt: AsyncIterable<sdkModule.SDKUserMessage>,
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

function getNativePromptText(message: sdkModule.SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is { type: 'text'; text: string } => (
      block.type === 'text'
    ))
    .map(block => block.text)
    .join('\n');
}

type ScriptedQuery = AsyncGenerator<unknown> & {
  interrupt: jest.Mock;
  setModel: jest.Mock;
  setPermissionMode: jest.Mock;
  setMcpServers: jest.Mock;
  applyFlagSettings: jest.Mock;
  supportedCommands: jest.Mock;
  rewindFiles: jest.Mock;
  finished: Promise<void>;
};

function attachQueryMethods(
  query: AsyncGenerator<unknown>,
  finished: Promise<void>,
): ScriptedQuery {
  return Object.assign(query, {
    interrupt: jest.fn().mockResolvedValue(undefined),
    setModel: jest.fn().mockResolvedValue(undefined),
    setPermissionMode: jest.fn().mockResolvedValue(undefined),
    setMcpServers: jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
    applyFlagSettings: jest.fn().mockResolvedValue(undefined),
    supportedCommands: jest.fn().mockResolvedValue([]),
    rewindFiles: jest.fn().mockResolvedValue({ canRewind: true, filesChanged: [] }),
    finished,
  });
}

function createThrowingPersistentQuery(error: Error): ReturnType<
  typeof createScriptedPersistentQuery
> {
  const throwing = (async function* () {
    await Promise.reject(error);
    yield undefined;
  })();
  return attachQueryMethods(throwing, Promise.resolve());
}

function createIdlePersistentQuery(): ReturnType<
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
