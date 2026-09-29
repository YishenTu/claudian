import '@/providers';

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createProviderRecoveryTestHarness } from '@test/helpers/features/chat/ProviderRecoveryTestHarness';
import { testTime } from '@test/helpers/testClock';

import {
  type ProviderExecutionEvent,
  ProviderExecutionLifecycleRegistry,
  type ProviderExecutionRequest,
  type ProviderInteractionPort,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionSnapshot,
} from '@/core/execution';
import { ProviderModelUnavailableError } from '@/core/providers/models/ProviderModelUnavailableError';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ClaudianSettings } from '@/core/types';
type MutableTestHost = ProviderHost & { settings: ClaudianSettings };
import type { Conversation } from '@/core/types';
import { createClaudeWorkspaceServices } from '@/providers/claude/app/ClaudeWorkspaceServices';
import { ClaudeExecutionBackend } from '@/providers/claude/execution/ClaudeExecutionBackend';
import { ClaudeExecutionSession } from '@/providers/claude/execution/ClaudeExecutionSession';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import * as historyStore from '@/providers/claude/history/ClaudeHistoryStore';
import { assertClaudeModelAvailable } from '@/providers/claude/runtime/ClaudeModelAvailability';
import { buildClaudeSDKUserMessage } from '@/providers/claude/runtime/ClaudeUserMessageFactory';
import { getClaudeProviderSettings } from '@/providers/claude/settings';
import * as env from '@/utils/env';

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
    applyFlagSettings: jest.Mock;
    interrupt: jest.Mock;
    setModel: jest.Mock;
    setPermissionMode: jest.Mock;
    setMcpServers: jest.Mock;
    supportedCommands: jest.Mock;
    getContextUsage: jest.Mock;
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
  setMockSupportedModels: (models: sdkModule.ModelInfo[]) => void;
  setMockContextUsage: (
    contextUsage: { rawMaxTokens: number } | null,
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
    dismissInteraction: jest.fn(),
  };
}

function createHost(): MutableTestHost {
  return {
    app: {
      vault: {
        adapter: {
          basePath: '/vault',
        },
      },
    },
    settings: {
      providerConfigs: { claude: claudeCatalogFixture(['claude-sonnet-4-5', 'claude-opus-4-6', 'claude-haiku-4-5', 'custom-model', 'custom-model-a', 'custom-model-b'], ['low', 'medium', 'high']) },
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
  } as unknown as MutableTestHost;
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

  it('passes Node-backed CLI paths to the SDK even when Node discovery misses', async () => {
    jest.spyOn(env, 'findNodeExecutable').mockReturnValue(null);
    const host = createHost();
    jest.mocked(host.getResolvedProviderCliPath).mockResolvedValue('/npm/claude/cli-wrapper.cjs');
    const session = new ClaudeExecutionBackend(host).createSession(createConfig());

    try {
      await collectEvents(session.execute(createRequest()).events);

      expect(sdkMock.getQueryCallCount()).toBe(1);
      expect(sdkMock.getLastOptions()?.pathToClaudeCodeExecutable).toBe('/npm/claude/cli-wrapper.cjs');
    } finally {
      await session.dispose();
    }
  });

  it('executes a migrated family alias using its enabled model and effort metadata', async () => {
    const host = createHost();
    host.settings.providerConfigs = { claude: {
      discoveredModels: [
        { value: 'claude-fable-5-10', label: 'Selected', description: '', supportedEffortLevels: ['high'] },
        { value: 'claude-fable-6-0', label: 'Unselected', description: '', supportedEffortLevels: ['low'] },
      ],
      visibleModels: ['claude-fable-5-10'],
    } };
    const session = new ClaudeExecutionBackend(host).createSession(createConfig());
    const request = createRequest();
    try {
      const events = await collectEvents(session.execute({
        ...request, configuration: { ...request.configuration, model: 'fable', reasoning: 'high' },
      }).events);
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'execution_error' }));
      expect(sdkMock.getLastOptions()?.model).toBe('claude-fable-5-10');
      expect(sdkMock.getLastOptions()?.effort).toBe('high');
    } finally {
      await session.dispose();
    }
  });

  it('rejects a bare alias whose exact SDK identity exists but is unselected', async () => {
    const host = createHost();
    host.settings.providerConfigs = { claude: {
      discoveredModels: [
        { value: 'opus', label: 'Opus', description: '' },
        { value: 'opus[1m]', label: 'Opus 1M', description: '' },
      ],
      visibleModels: ['opus[1m]'],
    } };
    expect(() => assertClaudeModelAvailable(host.settings, 'opus')).toThrow(ProviderModelUnavailableError);
    const session = new ClaudeExecutionBackend(host).createSession(createConfig());
    const request = createRequest();
    const events = await collectEvents(session.execute({
      ...request, configuration: { ...request.configuration, model: 'opus' },
    }).events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'execution_error', category: 'configuration' }));
    expect(sdkMock.getQueryCallCount()).toBe(0);
    await session.dispose();
  });

  it('rejects ambiguous saved model identities even if only one matching row is enabled', async () => {
    const host = createHost();
    host.settings.providerConfigs = { claude: {
      discoveredModels: ['sonnet', 'opus'].map(value => ({ value, label: value, description: '', resolvedModel: 'gateway-model' })),
      visibleModels: ['sonnet'],
    } };
    const session = new ClaudeExecutionBackend(host).createSession(createConfig());
    const request = createRequest();
    const events = await collectEvents(session.execute({
      ...request, configuration: { ...request.configuration, model: 'gateway-model' },
    }).events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'execution_error', category: 'configuration' }));
    expect(JSON.stringify(events)).toContain('selected Claude model is unavailable');
    expect(JSON.stringify(events)).toContain('Open Claudian settings → Claude');
    expect(sdkMock.getQueryCallCount()).toBe(0);
    await session.dispose();
  });

  it('keeps native success when cancellation arrives during stats loading', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-throughput-'));
    const directory = path.join(home, 'projects', '-vault');
    await fs.mkdir(directory, { recursive: true });
    const sessionFile = path.join(directory, 'session-1.jsonl');
    await fs.writeFile(sessionFile, [
      { type: 'user', uuid: 'u', timestamp: testTime(), message: { content: 'Work' } },
      { type: 'assistant', uuid: 'a', parentUuid: 'u', timestamp: testTime({ milliseconds: 2500 }),
        message: { id: 'response', stop_reason: 'end_turn', usage: { output_tokens: 125 }, content: [{ type: 'text', text: 'Done' }] } },
    ].map(record => JSON.stringify(record)).join('\n'));
    const host = createHost();
    jest.mocked(host.getActiveEnvironmentVariables).mockReturnValue(`CLAUDE_CONFIG_DIR=${home}`);
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'assistant', uuid: 'a', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done' }] } },
      { type: 'result', subtype: 'success', duration_ms: 3000, usage: { output_tokens: 125 } },
    ], { appendResult: false });
    const session = new ClaudeExecutionBackend(host).createSession(createConfig());
    const readStarted = createDeferred<void>();
    const releaseRead = createDeferred<void>();
    const nativeRead = fs.readFile;
    jest.spyOn(jest.requireActual<typeof fs>('node:fs/promises'), 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === sessionFile) {
        readStarted.resolve();
        await releaseRead.promise;
      }
      return nativeRead(...args);
    }) as typeof fs.readFile);
    const nativeOpen = fs.open;
    jest.spyOn(jest.requireActual<typeof fs>('node:fs/promises'), 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === sessionFile) {
        readStarted.resolve();
        await releaseRead.promise;
      }
      return nativeOpen(...args);
    });
    try {
      const run = session.execute(createRequest());
      const eventPromise = collectEvents(run.events);
      await readStarted.promise;
      expect(session.getSnapshot().status).toBe('executing');
      run.cancel();
      releaseRead.resolve();
      const events = await eventPromise;
      const replay = await historyStore.loadSDKSessionMessages('/vault', 'session-1', undefined, sessionFile);
      expect(events.at(-1)).toMatchObject({ type: 'turn_completed', turnStats: { outputTokens: 125, durationMs: 2500 } });
      expect(events.at(-1)).toMatchObject({ turnStats: replay.messages.at(-1)?.turnStats });
    } finally {
      releaseRead.resolve();
      await session.dispose();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('disables native mode-switching and task-list tools in the SDK execution policy', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const session = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig());

    await collectEvents(session.execute(createRequest()).events);

    expect(sdkMock.getLastOptions()?.disallowedTools).toEqual([
      'EnterPlanMode',
      'ExitPlanMode',
      'TodoWrite',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskUpdate',
      'Task(statusline-setup)',
    ]);
  });

  it.each([
    ['bypassPermissions', 'yolo'],
    ['default', 'normal'],
    ['acceptEdits', 'normal'],
    ['auto', 'normal'],
    ['dontAsk', 'normal'],
    ['delegate', 'normal'],
    ['plan', 'normal'],
    ['future-mode', 'normal'],
    ['yolo', 'normal'],
    ['', 'normal'],
    [null, 'normal'],
    [false, 'normal'],
  ])('normalizes native permission %p to %s in execution events', async (nativeMode, permissionMode) => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1', permissionMode: nativeMode },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const session = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig());

    const events = await collectEvents(session.execute(createRequest()).events);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'permission_mode_changed',
      permissionMode,
      scope: expect.objectContaining({ kind: 'requested', sessionInstanceId: session.sessionInstanceId }),
      snapshot: expect.objectContaining({ providerId: 'claude', providerSessionId: 'session-1' }),
    }));
  });

  it.each(['persistent', 'ephemeral'] as const)(
    'keeps pushed commands over delayed initialization metadata in a %s session',
    async (lifecycle) => {
      const metadata = createDeferred<sdkModule.SlashCommand[]>();
      const finish = createDeferred<unknown>();
      const query = createScriptedPersistentQuery([[
        { type: 'system', subtype: 'init', session_id: 'session-1' },
        {
          type: 'system', subtype: 'commands_changed',
          commands: [{ name: 'new-command', description: 'New command', argumentHint: '' }],
        },
        finish.promise,
      ]]);
      query.supportedCommands.mockReturnValue(metadata.promise);
      jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
        .mockResolvedValueOnce((() => query) as unknown as typeof sdkModule.query);
      const host = createHost();
      const session = new ClaudeExecutionBackend(host)
        .createSession(createConfig({ lifecycle }));
      const events = collectEvents(session.execute(createRequest()).events);
      try {
        await waitFor(() => query.supportedCommands.mock.calls.length > 0);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(session.getCommandSnapshot())
          .toEqual([expect.objectContaining({ name: 'new-command' })]);
        metadata.resolve([{ name: 'old-command', description: 'Old command', argumentHint: '' }]);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(session.getCommandSnapshot())
          .toEqual([expect.objectContaining({ name: 'new-command' })]);
      } finally {
        finish.resolve({ type: 'result', subtype: 'success' });
        await events;
        await session.dispose();
      }
    },
  );

  it('writes a live session model list back once and leaves unchanged catalogs alone', async () => {
    const host = createHost();
    const registry = new ProviderExecutionLifecycleRegistry();
    let writes = 0;
    Object.assign(host, {
      executionLifecycleRegistry: registry,
      mutateSettingsConditionally: jest.fn(async (mutation: (settings: ClaudianSettings) => Promise<boolean> | boolean) => {
        if (await mutation(host.settings)) writes += 1;
      }),
      notifyProviderChatOptionsChanged: jest.fn(),
    });
    const services = await createClaudeWorkspaceServices(host, { commandProbe: async () => [], modelProbe: jest.fn() });
    const publications: Array<Promise<void>> = [];
    const backend = new ClaudeExecutionBackend(host, {
      publishSessionModels: models => {
        const publication = services.publishSessionModels(models);
        publications.push(publication);
        return publication;
      },
    });
    const reported = getClaudeProviderSettings(host.settings).discoveredModels.map(model => ({
      value: model.value, displayName: model.label, description: model.description,
      supportedEffortLevels: model.supportedEffortLevels,
    }));
    sdkMock.setMockSupportedModels([
      ...reported,
      { value: 'claude-fable-6-0', displayName: 'Fable 6', description: 'Newest', supportedEffortLevels: ['low', 'high'] },
    ]);

    try {
      for (let sessionIndex = 1; sessionIndex <= 2; sessionIndex += 1) {
        const session = backend.createSession(createConfig());
        await collectEvents(session.execute(createRequest()).events);
        await waitFor(() => publications.length === sessionIndex);
        await Promise.all(publications);
        await session.dispose();
        expect(writes).toBe(1);
      }
      expect(getClaudeProviderSettings(host.settings).discoveredModels).toContainEqual({
        value: 'claude-fable-6-0',
        label: 'Fable 6',
        description: 'Newest',
        reasoningMetadataResolved: true,
        supportedEffortLevels: ['low', 'high'],
      });
      expect(host.notifyProviderChatOptionsChanged).toHaveBeenCalledTimes(1);
      expect(host.notifyProviderChatOptionsChanged).toHaveBeenCalledWith('claude');
    } finally {
      await services.dispose();
      await registry.dispose();
    }
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
    const session = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig());

    const commandSnapshots: unknown[] = [];
    session.onEvent(event => {
      if (event.type === 'commands_changed') commandSnapshots.push(session.getCommandSnapshot());
    });
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
    expect(commandSnapshots).toContainEqual([
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
    const session = new ClaudeExecutionBackend(createHost())
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
    const backend = new ClaudeExecutionBackend(createHost());
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
        reasoning: null,
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

  it.each(['configuration change', 'process exit'] as const)(
    'requires a new auxiliary request after a non-persistent %s',
    async (reason) => {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'auxiliary-session' },
        { type: 'result', subtype: 'success' },
      ];
      const closedQuery = reason === 'process exit'
        ? createScriptedPersistentQuery([messages])
        : null;
      if (closedQuery) {
        jest.spyOn(
          await import('@/providers/claude/loadClaudeAgentSDK'),
          'loadClaudeAgentQuery',
        ).mockResolvedValueOnce((() => closedQuery) as never);
      } else {
        sdkMock.setMockMessages(messages, { appendResult: false });
      }
      const session = new ClaudeExecutionBackend(createHost())
        .createSession(createConfig({
          lifecycle: 'ephemeral',
          nativePersistence: 'disabled-if-supported',
        }));
      const request = createRequest({
        configuration: {
          systemInstructions: { kind: 'explicit', instructions: 'Edit the draft.' },
        },
        toolPolicy: { kind: 'read-only' },
      });

      try {
        const first = await collectEvents(session.execute(request).events);
        expect(first.at(-1)).toMatchObject({ type: 'turn_completed' });
        if (closedQuery) {
          await closedQuery.finished;
          await waitFor(() => session.getStatus() === 'invalidated');
        }

        const continuation = await collectEvents(session.execute({
          ...request,
          input: [{ type: 'text', text: 'Make it more formal.' }],
          ...(reason === 'configuration change'
            ? {
                configuration: {
                  systemInstructions: {
                    kind: 'explicit' as const,
                    instructions: 'Edit the draft with new guidance.',
                  },
                },
              }
            : {}),
        }).events);

        expect(continuation.at(-1)).toMatchObject({
          type: 'execution_error',
          message: expect.any(String),
        });
      } finally {
        await session.dispose();
      }
    },
  );

  it.each(['configuration change', 'process exit'] as const)(
    'requires a new non-persistent session after %s even with supplied history',
    async (reason) => {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'memory-session' },
        { type: 'result', subtype: 'success' },
      ];
      const closedQuery = reason === 'process exit' ? createScriptedPersistentQuery([messages]) : null;
      if (closedQuery) {
        jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
          .mockResolvedValueOnce((() => closedQuery) as never);
      }
      sdkMock.setMockMessages(messages, { appendResult: false });
      const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig({
        lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported',
      }));
      try {
        await collectEvents(session.execute(createRequest()).events);
        if (closedQuery) {
          await closedQuery.finished;
          await waitFor(() => session.getStatus() === 'invalidated');
        }
        const request = createRequest({
          conversationHistory: [
            { id: 'u1', role: 'user', content: 'Remember A', timestamp: 1, images: [{
              id: 'captured', name: 'captured.png', data: 'aW1hZ2U=',
              mediaType: 'image/png', source: 'paste', size: 5,
            }] },
            { id: 'a1', role: 'assistant', content: 'Noted A', timestamp: 2 },
          ],
          input: [{ type: 'text', text: 'Continue with B' }],
          ...(reason === 'configuration change' ? {
            configuration: { systemInstructions: { kind: 'explicit', instructions: 'New guidance' } },
          } : {}),
        });
        const events = await collectEvents(session.execute(request).events);
        expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: expect.stringContaining('cannot be restored') });
      } finally {
        await session.dispose();
      }
    },
  );

  it('maps images and structured context without injecting legacy MCP configuration', async () => {
    sdkMock.setMockMessages([
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const session = new ClaudeExecutionBackend(createHost())
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
        linkedContent: { path: 'note.md' },
      },
      configuration: {
        systemInstructions: { kind: 'provider-default' },
      },
      toolPolicy: { kind: 'allow-list', names: ['Read', 'Grep'] },
    })).events);

    expect(mockBuildClaudeSDKUserMessage).toHaveBeenCalledTimes(1);
    expect(mockBuildClaudeSDKUserMessage.mock.results[0]?.value.message.content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
      },
      { type: 'text', text: '@mentioned Explain this\n\n<linked_content path="note.md" />' },
    ]);
    expect(getEncodedPrompts()).toEqual([
      '@mentioned Explain this\n\n<linked_content path="note.md" />',
    ]);
    expect(sdkMock.getLastOptions()).toEqual(expect.objectContaining({
      cwd: '/vault',
      tools: ['Read', 'Grep'],
    }));
    expect(sdkMock.getLastOptions()?.mcpServers).toBeUndefined();
  });

  it('passes provider-default dynamic sections through a non-snapshotted custom system prompt', async () => {
    sdkMock.setMockMessages([
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const session = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig({ lifecycle: 'ephemeral' }));

    await collectEvents(session.execute(createRequest({
      configuration: {
        systemInstructions: {
          dynamicSections: ['## Additional context\nRuntime guidance.'],
          kind: 'provider-default',
        },
      },
    })).events);

    const systemPrompt = sdkMock.getLastOptions()?.systemPrompt;
    expect(systemPrompt).toEqual({
      type: 'custom',
      prompt: expect.stringContaining('## Runtime Context'),
      snapshot: false,
    });
    expect((systemPrompt as { prompt: string }).prompt).toContain(
      '## Additional context\nRuntime guidance.',
    );
    expect((systemPrompt as { prompt: string }).prompt.match(/## Additional context/g))
      .toHaveLength(1);
  });

  it('encodes structured context with escaped XML paths and bodies', async () => {
    sdkMock.setMockMessages([
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const session = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig({ lifecycle: 'ephemeral' }));

    await collectEvents(session.execute(createRequest({
      context: {
        linkedContent: {
          path: 'notes/"draft" & review.md',
          content: 'Before\n]]>\nAfter',
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
      '<linked_content path="notes/&quot;draft&quot; &amp; review.md">\n<![CDATA[Before\n]]]]><![CDATA[>\nAfter]]>\n</linked_content>',
    );
    expect(prompt).not.toContain('<linked_note');
    expect(prompt).not.toContain('<current_note');
    expect(prompt).toContain(
      '<editor_selection path="notes/&quot;draft&quot; &amp; review.md">\n<![CDATA[Selected]]>',
    );
  });

  it('normalizes tools, usage, compaction', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'read-main', name: 'Read', input: { file_path: 'main.md' } },
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
    const session = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig());

    const events = await collectEvents(session.execute(createRequest()).events);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_started',
      toolCallId: 'read-main',
      toolScope: { kind: 'main' },
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

  it('uses the result model window without polling the autocompact threshold', async () => {
    // getContextUsage reports the autocompact window, which compaction policy can set below the
    // model window; result modelUsage reports the model window itself.
    sdkMock.setMockContextUsage({ rawMaxTokens: 200_000 });
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: { input_tokens: 100_000 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        modelUsage: {
          'custom-model': { contextWindow: 1_000_000 },
        },
      },
    ], { appendResult: false });
    const session = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig());

    const events = await collectEvents(session.execute(createRequest({
      configuration: {
        systemInstructions: { kind: 'provider-default' },
        model: 'custom-model',
        reasoning: 'medium',
        permissionMode: 'ask',
      },
    })).events);

    expect(sdkMock.getLastResponse()?.getContextUsage).not.toHaveBeenCalled();
    const usageEvents = events.filter((event) => event.type === 'usage_updated');
    expect(usageEvents.at(-1)).toEqual(expect.objectContaining({
      type: 'usage_updated',
      usage: expect.objectContaining({
        model: 'custom-model',
        contextTokens: 100_000,
        contextWindow: 1_000_000,
        percentage: 10,
      }),
    }));
  });

  it('reuses only the last reported model window on a persistent query', async () => {
    const queryFactory = jest.fn((request: { prompt: AsyncIterable<sdkModule.SDKUserMessage> }) =>
      createPromptDrivenPersistentQuery(request.prompt, (prompt) => [
        { type: 'assistant', message: {
          content: [{ type: 'text', text: 'Response' }], usage: { input_tokens: 100_000 },
        } },
        { type: 'result', subtype: 'success', modelUsage: prompt.includes('Other model')
          ? { 'custom-model-b': { contextWindow: 200_000 } }
          : { 'custom-model': { contextWindow: 1_000_000 } } },
      ]));
    jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
      .mockResolvedValueOnce(queryFactory as never);
    const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
    const execute = async (model: string, text: string) => {
      const events = await collectEvents(session.execute(createRequest({
        input: [{ type: 'text', text }],
        configuration: {
          systemInstructions: { kind: 'provider-default' }, model, reasoning: 'medium', permissionMode: 'ask',
        },
      })).events);
      return events.filter(event => event.type === 'usage_updated').map(event => event.usage.contextWindow);
    };
    try {
      expect(await execute('custom-model', 'First turn')).toEqual([0, 1_000_000]);
      expect(await execute('custom-model', 'Same model')).toEqual([1_000_000]);
      expect(await execute('custom-model-b', 'Other model')).toEqual([0, 200_000]);
      expect(await execute('custom-model', 'Return to first model')).toEqual([0, 1_000_000]);
      expect(queryFactory).toHaveBeenCalledTimes(1);
    } finally {
      await session.dispose();
    }
  });

  it('corrects custom-model usage from result model metadata', async () => {
    sdkMock.setMockMessages([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: { input_tokens: 250_000 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        modelUsage: {
          'custom-model': { contextWindow: 1_000_000 },
        },
      },
    ], { appendResult: false });
    const session = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig());

    const events = await collectEvents(session.execute(createRequest({
      configuration: {
        systemInstructions: { kind: 'provider-default' },
        model: 'custom-model',
        reasoning: 'medium',
        permissionMode: 'ask',
      },
    })).events);
    const usageEvents = events.filter((event) => event.type === 'usage_updated');

    expect(usageEvents.at(-1)).toEqual(expect.objectContaining({
      type: 'usage_updated',
      usage: expect.objectContaining({
        model: 'custom-model',
        contextTokens: 250_000,
        contextWindow: 1_000_000,
                percentage: 25,
      }),
    }));
  });

  it('applies result context metadata before terminating an errored turn', async () => {
    sdkMock.setMockMessages([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Partial output' }],
          usage: { input_tokens: 250_000 },
        },
      },
      {
        type: 'result',
        subtype: 'error_max_turns',
        errors: ['Hit maximum turn limit'],
        modelUsage: {
          'custom-model': { contextWindow: 1_000_000 },
        },
      },
    ], { appendResult: false });
    const session = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig());

    const events = await collectEvents(session.execute(createRequest({
      configuration: {
        systemInstructions: { kind: 'provider-default' },
        model: 'custom-model',
        reasoning: 'medium',
        permissionMode: 'ask',
      },
    })).events);

    expect(events.filter((event) => event.type === 'usage_updated').at(-1))
      .toEqual(expect.objectContaining({
        usage: expect.objectContaining({
          contextWindow: 1_000_000,
                    percentage: 25,
        }),
      }));
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'execution_error',
      message: 'Hit maximum turn limit',
    }));
  });

  it('enforces read-only policy through both tool exposure and the native hook', async () => {
    sdkMock.setMockMessages([
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const interactionPort = createInteractionPort();
    const session = new ClaudeExecutionBackend(createHost())
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

  it('uses native output styles at launch and updates them on the same session', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const host = createHost();
    host.settings.providerConfigs = { claude: { ...claudeCatalogFixture(['claude-sonnet-4-5'], ['low', 'medium', 'high']), responseStyle: 'Concise' } };
    const session = new ClaudeExecutionBackend(host).createSession(createConfig());

    await collectEvents(session.execute(createRequest()).events);
    expect(sdkMock.getLastOptions()?.settings).toEqual({ outputStyle: 'Concise' });
    const query = sdkMock.getLastResponse();
    for (const responseStyle of ['Default', 'Concise']) {
      host.settings.providerConfigs = { claude: { ...claudeCatalogFixture(['claude-sonnet-4-5'], ['low', 'medium', 'high']), responseStyle } };
      await collectEvents(session.execute(createRequest()).events);
      expect(sdkMock.getLastResponse()).toBe(query);
      expect(query?.applyFlagSettings).toHaveBeenLastCalledWith({ outputStyle: responseStyle });
    }
    await session.dispose();
  });

  it('applies model, effort, and permission changes without replacing a compatible persistent query', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const host = createHost();
    host.settings.providerConfigs = { claude: claudeCatalogFixture(
      ['claude-sonnet-4-5', 'claude-opus-4-6'],
      ['low', 'medium', 'high'],
    ) };
    const session = new ClaudeExecutionBackend(host)
      .createSession(createConfig());

    await collectEvents(session.execute(createRequest()).events);
    const query = sdkMock.getLastResponse();
    await collectEvents(session.execute(createRequest({
      configuration: {
        systemInstructions: { kind: 'provider-default' },
        model: 'claude-opus-4-6',
        reasoning: 'high',
        permissionMode: 'yolo',
      },
    })).events);

    expect(sdkMock.getQueryCallCount()).toBe(1);
    expect(query?.setModel).toHaveBeenCalledWith('claude-opus-4-6');
    expect(query?.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'high' });
    expect(query?.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect(query?.setMcpServers).not.toHaveBeenCalled();
  });

  it.each(['xhigh', 'high'])('rejects unsupported toolbar effort %s without substituting a default', async reasoning => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const host = createHost();
    host.settings.providerConfigs = { claude: claudeCatalogFixture(['claude-sonnet-4-5'], ['low', 'medium']) };
    const session = new ClaudeExecutionBackend(host).createSession(createConfig());
    const request = createRequest();

    const events = await collectEvents(session.execute({
      ...request, configuration: { ...request.configuration, reasoning },
    }).events);

    expect(events).toContainEqual(expect.objectContaining({ type: 'execution_error' }));
    expect(sdkMock.getLastOptions()).toBeUndefined();
    await session.dispose();
  });

  it('sends no explicit effort without reported capabilities', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const host = createHost();
    host.settings.providerConfigs = { claude: claudeCatalogFixture(['claude-sonnet-4-5']) };
    const session = new ClaudeExecutionBackend(host).createSession(createConfig());

    const request = createRequest();
    await collectEvents(session.execute({ ...request, configuration: { ...request.configuration, reasoning: null } }).events);

    expect(sdkMock.getLastOptions()).not.toHaveProperty('effort');
    await session.dispose();
  });

  it('clears a live effort override when the next model reports no capabilities', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const host = createHost();
    const withEffort = claudeCatalogFixture(['claude-sonnet-4-5'], ['low', 'medium', 'high']);
    host.settings.providerConfigs = { claude: {
      visibleModels: ['claude-sonnet-4-5', 'claude-opus-4-6'],
      discoveredModels: [
        ...withEffort.discoveredModels,
        { value: 'claude-opus-4-6', label: 'claude-opus-4-6', description: 'SDK model' },
      ],
    } };
    const session = new ClaudeExecutionBackend(host).createSession(createConfig());

    await collectEvents(session.execute(createRequest()).events);
    expect(sdkMock.getLastOptions()?.effort).toBe('medium');
    const query = sdkMock.getLastResponse();
    const request = createRequest();
    await collectEvents(session.execute({
      ...request, configuration: { ...request.configuration, model: 'claude-opus-4-6', reasoning: null },
    }).events);

    expect(sdkMock.getQueryCallCount()).toBe(1);
    expect(query?.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: null });
    await session.dispose();
  });

  it('switches into auto safe mode on the same persistent query', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const host = createHost();
    host.settings.providerConfigs = { claude: { ...claudeCatalogFixture(['claude-sonnet-4-5'], ['low', 'medium', 'high']), safeMode: 'default' } };
    const session = new ClaudeExecutionBackend(host)
      .createSession(createConfig());

    await collectEvents(session.execute(createRequest()).events);
    const query = sdkMock.getLastResponse();
    host.settings.providerConfigs = { claude: { ...claudeCatalogFixture(['claude-sonnet-4-5'], ['low', 'medium', 'high']), safeMode: 'auto' } };
    await collectEvents(session.execute(createRequest()).events);

    expect(sdkMock.getQueryCallCount()).toBe(1);
    expect(query?.setPermissionMode).toHaveBeenLastCalledWith('auto');
    await session.dispose();
  });

  it('replays canonical history only while bootstrapping a native session', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    const session = new ClaudeExecutionBackend(createHost())
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
    const session = new ClaudeExecutionBackend(createHost())
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
    const host = createHost();
    const session = new ClaudeExecutionBackend(host)
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    )
      .mockResolvedValueOnce(failedFactory as never)
      .mockResolvedValueOnce((() => retryQuery) as never);
    const session = new ClaudeExecutionBackend(createHost())
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
        permissionMode: 'default',
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce(queryFactory as never);
    const requestAbortController = new AbortController();
    const session = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig({
        resumeSeed: {
          providerSessionId: 'replacement-session',
          providerState: {
            historyReplayPending: true,
            providerSessionId: 'replacement-session',
          },
        },
      }));

    const run = session.execute(createRequest({
      conversationHistory: [
        { id: 'history-user', role: 'user', content: 'startup history question', timestamp: 1 },
        { id: 'history-assistant', role: 'assistant', content: 'startup history answer', timestamp: 2 },
      ],
      signal: requestAbortController.signal,
    }));
    const events: ProviderExecutionEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'permission_mode_changed') {
        requestAbortController.abort();
      }
    }
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    )
      .mockResolvedValueOnce(firstFactory as never)
      .mockResolvedValueOnce(retryFactory as never);
    const session = new ClaudeExecutionBackend(createHost())
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

    const replacement = new ClaudeExecutionBackend(createHost())
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
    const backend = new ClaudeExecutionBackend(createHost());
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const backend = new ClaudeExecutionBackend(createHost());
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    jest.spyOn(historyStore, 'locateSDKSessions').mockResolvedValue(new Map([
      ['previous-session', { availability: 'unknown' }],
      ['missing-session', { availability: 'missing' }],
    ]));
    const backend = new ClaudeExecutionBackend(createHost());
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
        Object.assign(current, resolution.changes);
        return resolution.outcome === 'delete' ? 'deleted' : resolution.outcome === 'preserve'
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    )
      .mockResolvedValueOnce((() => failedQuery) as never)
      .mockResolvedValueOnce((() => recoveredQuery) as never);
    const session = new ClaudeExecutionBackend(createHost())
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const session = new ClaudeExecutionBackend(createHost())
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

    const withoutSeed = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig());
    await expect(withoutSeed.previewRewind(
      'user-1',
      undefined,
    )).resolves.toEqual(expect.objectContaining({
      canRewind: false,
    }));
  });

  it.each([false, true])('keeps main execution available around a text-only async child with streaming=%s', async childStreaming => {
    const childReached = createDeferred<null>();
    const resume = createDeferred<unknown>();
    const keepOpen = createDeferred<unknown>();
    const childEnd = [
      { type: 'stream_event', parent_tool_use_id: 'async-agent', event: { type: 'message_stop' } },
      { type: 'assistant', uuid: 'child-checkpoint', parent_tool_use_id: 'async-agent',
        message: { id: 'child-message', content: [{ type: 'text', text: 'Child answer' }] } },
    ];
    const query = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'assistant', message: { id: 'parent-message', content: [
        { type: 'tool_use', id: 'async-agent', name: 'Agent', input: { prompt: 'Compute a result', run_in_background: true } },
      ] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'async-agent', content: 'Running in background' }] } },
      { type: 'result', subtype: 'success' },
      { type: 'stream_event', parent_tool_use_id: 'async-agent', event: {
        type: 'message_start', message: { id: 'child-message', usage: {} },
      } },
      { type: 'stream_event', parent_tool_use_id: 'async-agent', event: {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Child answer' },
      } },
      ...(!childStreaming ? childEnd : []),
      { then: (resolve: (value: null) => void) => { childReached.resolve(null); resolve(null); } },
      resume.promise,
      { type: 'assistant', uuid: 'next-checkpoint', message: { id: 'next-message', content: [{ type: 'text', text: 'Next answer' }] } },
      ...(childStreaming ? childEnd : []),
      { type: 'result', subtype: 'success' },
      keepOpen.promise,
    ]]);
    jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
      .mockResolvedValueOnce((() => query) as never);
    const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
    const background: ProviderSessionEvent[] = [];
    session.onEvent(event => background.push(event));
    let next: Promise<ProviderExecutionEvent[]> | undefined;
    try {
      await collectEvents(session.execute(createRequest()).events);
      await childReached.promise;
      expect(session.getStatus()).toBe('idle');
      expect(background.filter(event => event.type === 'background_turn_started')).toEqual([]);
      next = collectEvents(session.execute(createRequest({ input: [{ type: 'text', text: 'Next request' }] })).events);
      await waitFor(() => getEncodedPrompts().includes('Next request'));
      resume.resolve(null);
      const events = await next;
      expect(events.filter(event => event.type === 'text_delta')).toEqual([
        expect.objectContaining({ text: 'Next answer' }),
      ]);
      expect(events.at(-1)?.type).toBe('turn_completed');
      expect(session.getStatus()).toBe('idle');
    } finally {
      resume.resolve(null); keepOpen.resolve(null);
      await next; await session.dispose();
    }
  });

  it.each(['requested', 'idle', 'background'] as const)(
    'publishes task notifications independently while %s', async (phase) => {
      const pause = createDeferred<unknown>();
      const query = createScriptedPersistentQuery([[
        { type: 'system', subtype: 'init', session_id: 'session-1' },
        ...(phase === 'requested' ? [] : [{ type: 'result', subtype: 'success' }]),
        ...(phase === 'background' ? [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Automatic work' }] } }] : []),
        { type: 'system', subtype: 'task_notification', session_id: 'session-1', task_id: 'task-1',
          status: 'completed', summary: 'Task finished' },
        consumedTaskNotification('task-1'),
        pause.promise,
        { type: 'result', subtype: 'success' },
      ]]);
      jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
        .mockResolvedValueOnce((() => query) as never);
      const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
      const events: ProviderSessionEvent[] = [];
      session.onEvent(event => events.push(event));
      const requested = collectEvents(session.execute(createRequest()).events);
      try {
        await waitFor(() => events.some(event => event.type === 'async_subagent_completed'));
        expect(events).toContainEqual(expect.objectContaining({
          type: 'task_notification', content: 'Task finished', scope: expect.objectContaining({ kind: 'session' }),
        }));
      } finally {
        pause.resolve(null);
        await requested;
        await query.finished;
        await session.dispose();
      }
    },
  );

  it('requests progress summaries and publishes subagent progress while the turn is running', async () => {
    const pause = createDeferred<unknown>();
    const query = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'system', subtype: 'task_progress', session_id: 'session-1', task_id: 'agent-1',
        tool_use_id: 'task-1', description: 'Research', last_tool_name: 'Grep', summary: 'Reading the auth module',
        usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 } },
      { type: 'system', subtype: 'task_progress', session_id: 'session-1', task_id: 'bash-1',
        description: 'Unowned', usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 } },
      pause.promise,
      { type: 'result', subtype: 'success' },
    ]]);
    let launchOptions: Record<string, unknown> | undefined;
    jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
      .mockResolvedValueOnce(((params: { options?: Record<string, unknown> }) => {
        launchOptions = params.options;
        return query;
      }) as never);
    const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
    const events: ProviderSessionEvent[] = [];
    session.onEvent(event => events.push(event));
    const requested = collectEvents(session.execute(createRequest()).events);
    try {
      await waitFor(() => events.some(event => event.type === 'subagent_progress'));
      expect(launchOptions).toMatchObject({ agentProgressSummaries: true });
      expect(events.filter(event => event.type === 'subagent_progress')).toEqual([
        expect.objectContaining({
          scope: expect.objectContaining({ kind: 'session' }),
          progress: {
            toolCallId: 'task-1', summary: 'Reading the auth module', lastToolName: 'Grep',
            toolUses: 3, totalTokens: 1200, durationMs: 4000,
          },
        }),
      ]);
    } finally {
      pause.resolve(null);
      await requested;
      await query.finished;
      await session.dispose();
    }
  });

  it.each(['before-tool', 'during-input'] as const)(
    'keeps an automatic native message and tool round together when input arrives %s', async (phase) => {
      const continuation = createDeferred<unknown>();
      const keepOpen = createDeferred<unknown>();
      const toolStart = { type: 'stream_event', parent_tool_use_id: null, event: {
        type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'read-background', name: 'Read', input: {} },
      } };
      const query = createScriptedPersistentQuery([[
        { type: 'system', subtype: 'init', session_id: 'session-1' },
        { type: 'result', subtype: 'success' },
        { type: 'stream_event', parent_tool_use_id: null, event: {
          type: 'message_start', message: { id: 'native-background', usage: {} },
        } },
        { type: 'stream_event', parent_tool_use_id: null, event: {
          type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking task output.' },
        } },
        ...(phase === 'during-input' ? [toolStart] : []),
        continuation.promise,
        ...(phase === 'before-tool' ? [toolStart] : []),
        { type: 'stream_event', parent_tool_use_id: null, event: {
          type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/task-output"}' },
        } },
        { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } },
        { type: 'assistant', uuid: 'background-checkpoint', message: { id: 'native-background', content: [
          { type: 'text', text: 'Checking task output.' },
          { type: 'tool_use', id: 'read-background', name: 'Read', input: { file_path: '/tmp/task-output' } },
          { type: 'tool_use', id: 'read-second', name: 'Read', input: { file_path: '/tmp/second' } },
          { type: 'tool_use', id: 'task-create', name: 'TaskCreate', input: { subject: 'Inspect output', activeForm: 'Inspecting output' } },
        ] } },
        { type: 'system', subtype: 'task_notification', session_id: 'session-1', task_id: 'task-1',
          status: 'completed', output_file: '/tmp/task-output', summary: 'Task finished' },
        consumedTaskNotification('task-1'),
        { type: 'user', message: { content: [
          { type: 'tool_result', tool_use_id: 'read-background', content: 'First output' },
          { type: 'tool_result', tool_use_id: 'read-second', content: 'Second output' },
        ] } },
        { type: 'user', tool_use_result: { task: { id: '1', subject: 'Inspect output' } }, message: { content: [
          { type: 'tool_result', tool_use_id: 'task-create', content: 'Task #1 created successfully: Inspect output' },
        ] } },
        { type: 'assistant', uuid: 'requested-checkpoint', message: { id: 'native-requested', content: [
          { type: 'text', text: 'Follow-up received.' },
        ] } },
        { type: 'result', subtype: 'success' },
        keepOpen.promise,
      ]]);
      jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
        .mockResolvedValueOnce((() => query) as never);
      const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
      const background: ProviderSessionEvent[] = [];
      session.onEvent(event => background.push(event));
      await collectEvents(session.execute(createRequest()).events);
      await waitFor(() => background.some(event => phase === 'during-input'
        ? event.type === 'tool_started' : event.type === 'text_delta'));
      const requested = collectEvents(session.execute(createRequest({ input: [{ type: 'text', text: 'Follow up' }] })).events);
      try {
        await waitFor(() => getEncodedPrompts().includes('Follow up'));
        continuation.resolve(null);
        const events = await requested;
        const started = background.find(event => event.type === 'background_turn_started')!;
        expect(background).toContainEqual(expect.objectContaining({
          type: 'tool_started', toolCallId: 'read-background', input: { file_path: '/tmp/task-output' },
          scope: expect.objectContaining({ kind: 'background', turnId: (started.scope as { turnId: string }).turnId }),
        }));
        expect(background.filter(event => event.type === 'tool_completed')).toEqual([
          expect.objectContaining({ toolCallId: 'read-background', content: 'First output' }),
          expect.objectContaining({ toolCallId: 'read-second', content: 'Second output' }),
          expect.objectContaining({ toolCallId: 'task-create' }),
        ]);
        expect(background).toContainEqual(expect.objectContaining({
          type: 'tool_started', toolCallId: 'task-create', name: 'TodoWrite',
          input: { todos: [{ id: '1', content: 'Inspect output', activeForm: 'Inspecting output', status: 'pending' }] },
        }));
        expect(background.filter(event => event.type === 'text_delta')).toEqual([
          expect.objectContaining({ text: 'Checking task output.' }),
        ]);
        expect(background).toContainEqual(expect.objectContaining({
          type: 'task_notification', scope: expect.objectContaining({ kind: 'session' }),
        }));
        expect(background).toContainEqual(expect.objectContaining({
          type: 'background_turn_completed', nativeAssistantId: 'background-checkpoint',
        }));
        expect(events.filter(event => event.type === 'text_delta')).toEqual([
          expect.objectContaining({ text: 'Follow-up received.' }),
        ]);
        expect(events.at(-1)).toEqual(expect.objectContaining({
          type: 'turn_completed', nativeAssistantId: 'requested-checkpoint',
        }));
        expect(session.getStatus()).toBe('idle');
      } finally {
        continuation.resolve(null);
        keepOpen.resolve(null);
        await requested;
        await session.dispose();
      }
    },
  );

  it.each(['single', 'batch'] as const)('uses the native %s input echo while earlier tools still own their results', async echo => {
    const resume = createDeferred<unknown>();
    const echoed = createDeferred<unknown>();
    const keepOpen = createDeferred<unknown>();
    let options: sdkModule.Options | undefined;
    const query = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
      { type: 'assistant', message: { id: 'background', content: [
        { type: 'tool_use', id: 'old-tool', name: 'Read', input: { file_path: '/tmp/output' } },
      ] } },
      resume.promise,
      echoed.promise,
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'Denied', is_error: true }] } },
      { type: 'assistant', message: { id: 'new-final', content: [{ type: 'text', text: 'New response ends.' }] } },
      { type: 'result', subtype: 'success' },
      keepOpen.promise,
    ]]);
    jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
      .mockResolvedValueOnce(((params: { options: sdkModule.Options }) => { options = params.options; return query; }) as never);
    const interactionPort = createInteractionPort();
    interactionPort.requestApproval.mockImplementation(async request => ({ interactionId: request.interactionId, decision: 'deny' }));
    const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig({ interactionPort }));
    const background: ProviderSessionEvent[] = [];
    session.onEvent(event => background.push(event));
    await collectEvents(session.execute(createRequest()).events);
    await waitFor(() => background.some(event => event.type === 'tool_started'));
    const requested = collectEvents(session.execute(createRequest({ input: [{ type: 'text', text: 'Follow up' }] })).events);
    try {
      await waitFor(() => getEncodedPrompts().includes('Follow up'));
      const nativeInput = mockBuildClaudeSDKUserMessage.mock.results.at(-1)!.value;
      const approval = await options!.canUseTool!('Read', { file_path: '/tmp/output' }, {
        signal: new AbortController().signal, toolUseID: 'old-tool', requestId: 'approve-old-tool',
      });
      expect(approval?.behavior).toBe('deny');
      const backgroundTurn = background.find(event => event.type === 'background_turn_started')!;
      expect(interactionPort.requestApproval.mock.calls[0][0].turnId).toBe((backgroundTurn.scope as { turnId: string }).turnId);
      resume.resolve(null);
      echoed.resolve({ type: 'assistant',
        ...(echo === 'single' ? { user_message_uuid: nativeInput.uuid }
          : { user_message_uuid: 'another-batched-input', user_message_uuids: [nativeInput.uuid, 'another-batched-input'] }),
        message: { id: 'new-response', content: [{ type: 'text', text: 'New response starts.' }] },
      });
      const events = await requested;
      expect(events.filter(event => event.type === 'text_delta')).toEqual([
        expect.objectContaining({ text: 'New response starts.' }),
        expect.objectContaining({ text: 'New response ends.' }),
      ]);
      expect(background).toContainEqual(expect.objectContaining({
        type: 'tool_completed', toolCallId: 'old-tool', isBlocked: true,
        scope: expect.objectContaining({ kind: 'background', turnId: (backgroundTurn.scope as { turnId: string }).turnId }),
      }));
      expect(background.filter(event => event.type === 'background_turn_completed')).toHaveLength(1);
    } finally {
      resume.resolve(null); echoed.resolve(null); keepOpen.resolve(null);
      await requested; await session.dispose();
    }
  });

  it.each(['echo', 'queued-count'] as const)('retains a queued request across automatic output identified by %s', async evidence => {
    const resume = createDeferred<unknown>();
    const answer = createDeferred<unknown>();
    const keepOpen = createDeferred<unknown>();
    const query = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Automatic response.' }] } },
      resume.promise,
      { type: 'stream_event', parent_tool_use_id: null, user_message_uuid: 'automatic-input', event: {
        type: 'message_start', message: { id: 'automatic-stream', usage: {} },
      } },
      { type: 'stream_event', parent_tool_use_id: null, event: {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Automatic continuation.' },
      } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } },
      { type: 'assistant', message: { id: 'automatic-stream', content: [{ type: 'text', text: 'Automatic continuation.' }] } },
      { type: 'result', subtype: 'success', ...(evidence === 'echo' ? { user_message_uuid: 'automatic-input' } : {}), queued_turn_count: 1 },
      answer.promise,
      { type: 'result', subtype: 'success' },
      keepOpen.promise,
    ]]);
    jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
      .mockResolvedValueOnce((() => query) as never);
    const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
    const background: ProviderSessionEvent[] = [];
    session.onEvent(event => background.push(event));
    await collectEvents(session.execute(createRequest()).events);
    await waitFor(() => background.some(event => event.type === 'text_delta'));
    const requested = collectEvents(session.execute(createRequest({ input: [{ type: 'text', text: 'Follow up' }] })).events);
    try {
      await waitFor(() => getEncodedPrompts().includes('Follow up'));
      const nativeInput = mockBuildClaudeSDKUserMessage.mock.results.at(-1)!.value;
      resume.resolve(null);
      await waitFor(() => background.some(event => event.type === 'background_turn_completed'));
      expect(session.getStatus()).toBe('executing');
      answer.resolve({ type: 'assistant', user_message_uuid: nativeInput.uuid,
        message: { id: 'requested', content: [{ type: 'text', text: 'Requested response.' }] },
      });
      const events = await requested;
      expect(events.filter(event => event.type === 'text_delta')).toEqual([
        expect.objectContaining({ text: 'Requested response.' }),
      ]);
      expect(events.at(-1)?.type).toBe('turn_completed');
    } finally {
      resume.resolve(null); answer.resolve(null); keepOpen.resolve(null);
      await requested; await session.dispose();
    }
  });

  it.each(['cancel', 'end', 'failure'] as const)('settles retained background ownership on %s', async ending => {
    const resume = createDeferred<unknown>();
    const messages = [
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'old-tool', name: 'Read', input: {} }] } },
      resume.promise,
    ];
    const query = ending === 'failure' ? createFailingPersistentQuery(messages, new Error('transport closed'))
      : createScriptedPersistentQuery([messages]);
    jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
      .mockResolvedValueOnce((() => query) as never);
    const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
    const background: ProviderSessionEvent[] = [];
    session.onEvent(event => background.push(event));
    await collectEvents(session.execute(createRequest()).events);
    await waitFor(() => background.some(event => event.type === 'tool_started'));
    const run = session.execute(createRequest({ input: [{ type: 'text', text: 'Follow up' }] }));
    const requested = collectEvents(run.events);
    try {
      await waitFor(() => getEncodedPrompts().includes('Follow up'));
      if (ending === 'cancel') run.cancel();
      resume.resolve(null);
      const events = await requested;
      await query.finished;
      expect(events.at(-1)?.type).toBe(ending === 'cancel' ? 'cancelled' : 'execution_error');
      expect(background.filter(event => event.type === 'background_turn_completed')).toEqual([
        expect.objectContaining({ reason: 'provider-ended' }),
      ]);
    } finally {
      resume.resolve(null); await requested; await session.dispose();
    }
  });

  it('settles prior automatic output when a user request is absorbed into its continuation', async () => {
    const continuation = createDeferred<unknown>();
    const keepQueryOpen = createDeferred<unknown>();
    const query = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading background result.' }] } },
      continuation.promise,
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Task finished; follow-up received.' }] } },
      { type: 'result', subtype: 'success' },
      keepQueryOpen.promise,
    ]]);
    jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
      .mockResolvedValueOnce((() => query) as never);
    const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
    const events: ProviderSessionEvent[] = [];
    session.onEvent(event => events.push(event));
    await collectEvents(session.execute(createRequest()).events);
    await waitFor(() => events.some(event => event.type === 'text_delta'));
    const followup = collectEvents(session.execute(createRequest({ input: [{ type: 'text', text: 'testing follow up' }] })).events);
    try {
      await waitFor(() => mockBuildClaudeSDKUserMessage.mock.calls.some(([input]) => input === 'testing follow up'));
      continuation.resolve(null);
      const requested = await followup;
      expect(events).toContainEqual(expect.objectContaining({ type: 'background_turn_completed' }));
      expect(requested).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'Task finished; follow-up received.' }));
      expect(session.getStatus()).toBe('idle');
    } finally {
      continuation.resolve(null);
      keepQueryOpen.resolve(null);
      await followup;
      await session.dispose();
    }
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const session = new ClaudeExecutionBackend(createHost())
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

  it.each([
    ['persistent', 'enabled'],
    ['ephemeral', 'disabled-if-supported'],
  ] as const)('cancels %s background output through the native query', async (lifecycle, nativePersistence) => {
    const query = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Background started' }] } },
      deferredMessage(),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Cancelled late output' }] } },
      { type: 'result', subtype: 'success' },
    ]]);
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const session = new ClaudeExecutionBackend(createHost())
      .createSession({ ...createConfig(), lifecycle, nativePersistence });
    const events: ProviderSessionEvent[] = [];
    session.onEvent(event => events.push(event));
    await collectEvents(session.execute(createRequest()).events);
    await waitFor(() => events.some(event => event.type === 'background_turn_started'));
    session.cancel();
    expect(query.interrupt).toHaveBeenCalled();
    expect(session.getSnapshot().status).toBe('cancelling');
    releaseDeferredMessage();
    await query.finished;
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'Cancelled late output' }));
    expect(events.filter(event => event.type === 'background_turn_completed')).toHaveLength(1);
    await session.dispose();
  });

  it('cancels the requested run when the consumer stops iterating while it is still open', async () => {
    const query = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      deferredMessage(),
      { type: 'result', subtype: 'success' },
    ]]);
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const session = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig());
    const run = session.execute(createRequest());
    await waitFor(() => query.supportedCommands.mock.calls.length > 0);

    await run.events[Symbol.asyncIterator]().return?.();

    expect(query.interrupt).toHaveBeenCalled();
    releaseDeferredMessage();
    await session.dispose();
  });

  it('keeps background output running when the consumer stops iterating after the requested turn ends', async () => {
    const query = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Background started' }] } },
      deferredMessage(),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Background finished' }] } },
      { type: 'result', subtype: 'success' },
    ]]);
    jest.spyOn(
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const session = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig());
    const events: ProviderSessionEvent[] = [];
    session.onEvent(event => events.push(event));

    for await (const event of session.execute(createRequest()).events) {
      if (event.type !== 'turn_completed') continue;
      await waitFor(() => events.some(({ type }) => type === 'background_turn_started'));
      break;
    }

    expect(query.interrupt).not.toHaveBeenCalled();
    expect(session.getSnapshot().status).not.toBe('cancelling');
    releaseDeferredMessage();
    await query.finished;
    expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'Background finished' }));
    await session.dispose();
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const session = new ClaudeExecutionBackend(createHost())
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

  it.each([
    ['persistent', 'enabled'],
    ['ephemeral', 'disabled-if-supported'],
  ] as const)('keeps a cancelled %s native turn quarantined while an immediate retry is active', async (lifecycle, nativePersistence) => {
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const session = new ClaudeExecutionBackend(createHost())
      .createSession(createConfig({ lifecycle, nativePersistence }));
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    )
      .mockResolvedValueOnce((() => cancelledQuery) as never)
      .mockResolvedValueOnce((() => retryQuery) as never);
    const session = new ClaudeExecutionBackend(createHost())
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce(queryFactory as never);
    const session = new ClaudeExecutionBackend(createHost())
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    )
      .mockResolvedValueOnce((() => cancelledQuery) as never)
      .mockResolvedValueOnce((() => retryQuery) as never);
    const session = new ClaudeExecutionBackend(createHost())
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const host = createHost();
    const resolveCliPath = host.getResolvedProviderCliPath as jest.Mock;
    resolveCliPath
      .mockImplementationOnce(() => encodingBarrier.promise.then(() => '/bin/claude'))
      .mockResolvedValue('/bin/claude');
    const session = new ClaudeExecutionBackend(host)
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    )
      .mockResolvedValueOnce((() => staleQuery) as never)
      .mockResolvedValueOnce((() => retryQuery) as never);
    const host = createHost();
    const resolveCliPath = host.getResolvedProviderCliPath as jest.Mock;
    const session = new ClaudeExecutionBackend(host)
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    )
      .mockImplementationOnce(() => staleLoader.promise as never)
      .mockImplementationOnce(() => retryLoader.promise as never);
    const session = new ClaudeExecutionBackend(createHost())
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const session = new ClaudeExecutionBackend(createHost())
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
      await import('@/providers/claude/loadClaudeAgentSDK'),
      'loadClaudeAgentQuery',
    ).mockResolvedValueOnce((() => query) as never);
    const session = new ClaudeExecutionBackend(createHost())
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

describe('ClaudeExecutionSession steering', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function startSteerableSession(
    script: (
      nextInput: () => Promise<sdkModule.SDKUserMessage>,
      keepOpen: Promise<unknown>,
    ) => AsyncGenerator<unknown>,
    config: Partial<ProviderSessionConfig> = {},
  ) {
    const keepOpen = createDeferred<unknown>();
    let query: ScriptedQuery | null = null;
    const loadQuery = jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
      .mockResolvedValueOnce((({ prompt }: { prompt: AsyncIterable<sdkModule.SDKUserMessage> }) => {
        query = createInputDrivenQuery(prompt, nextInput => script(nextInput, keepOpen.promise));
        return query;
      }) as never);
    const backendSession = new ClaudeExecutionBackend(createHost()).createSession(createConfig(config));
    const session = Object.assign(backendSession, {
      dispose: async () => {
        keepOpen.resolve(null);
        await ClaudeExecutionSession.prototype.dispose.call(backendSession);
      },
    });
    const sessionEvents: ProviderSessionEvent[] = [];
    session.onEvent(event => sessionEvents.push(event));
    const run = session.execute(createRequest({ input: [{ type: 'text', text: 'Refactor the parser' }] }));
    const events: ProviderExecutionEvent[] = [];
    const done = (async () => {
      for await (const event of run.events) events.push(event);
    })();
    return { session, run, events, done, sessionEvents, loadQuery, getQuery: () => query };
  }

  function steerRequest(text: string): ProviderExecutionRequest {
    return createRequest({ input: [{ type: 'text', text }] });
  }

  it('folds a steer into the running native turn at its replay acknowledgement', async () => {
    const steerReceived = createDeferred<sdkModule.SDKUserMessage>();
    const { session, events, done, sessionEvents } = await startSteerableSession(async function* (nextInput, keepOpen) {
      const prompt = await nextInput();
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      yield replayOf(prompt);
      yield assistantText('assistant-1', 'Reading the parser.');
      const steer = await nextInput();
      steerReceived.resolve(steer);
      yield replayOf(steer);
      yield assistantText('assistant-2', 'Switching to tabs.');
      yield { type: 'result', subtype: 'success', user_message_uuids: [prompt.uuid, steer.uuid], queued_turn_count: 0 };
      await keepOpen;
    });
    try {
      await waitFor(() => events.some(event => event.type === 'text_delta'));
      await expect(session.steer(steerRequest('Use tabs instead'))).resolves.toBe(true);
      await done;

      const steer = await steerReceived.promise;
      expect(steer.priority).toBe('next');
      expect(getNativePromptText(steer)).toBe('Use tabs instead');
      const boundaryIndex = events.findIndex(event => (
        event.type === 'user_message_started' && event.nativeUserMessageId === steer.uuid
      ));
      expect(events[boundaryIndex]).toMatchObject({ content: 'Use tabs instead' });
      expect(events.findIndex(event => event.type === 'text_delta' && event.text === 'Switching to tabs.'))
        .toBeGreaterThan(boundaryIndex);
      expect(events.slice(boundaryIndex + 1)).toContainEqual(expect.objectContaining({
        type: 'assistant_message_started',
        nativeAssistantId: 'assistant-2',
      }));
      expect(events.filter(event => event.type === 'turn_completed')).toHaveLength(1);
      expect(sessionEvents.some(event => event.type === 'background_turn_started')).toBe(false);
    } finally {
      await session.dispose();
    }
  });

  it('keeps the run open when Claude runs a late steer as its next native turn', async () => {
    const { session, events, done, sessionEvents } = await startSteerableSession(async function* (nextInput, keepOpen) {
      const prompt = await nextInput();
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      yield replayOf(prompt);
      yield assistantText('assistant-1', 'Parser refactored.');
      const steer = await nextInput();
      yield { type: 'result', subtype: 'success', user_message_uuids: [prompt.uuid], queued_turn_count: 1 };
      yield replayOf(steer);
      yield { type: 'stream_event', parent_tool_use_id: null, user_message_uuid: steer.uuid,
        event: { type: 'message_start', message: { id: 'message-2', usage: {} } } };
      yield assistantText('assistant-2', 'Also added tests.');
      yield { type: 'result', subtype: 'success', user_message_uuids: [steer.uuid], queued_turn_count: 0 };
      await keepOpen;
    });
    try {
      await waitFor(() => events.some(event => event.type === 'text_delta'));
      await expect(session.steer(steerRequest('Add tests too'))).resolves.toBe(true);
      await done;

      expect(events.filter(event => event.type === 'text_delta').map(event => event.text))
        .toEqual(['Parser refactored.', 'Also added tests.']);
      expect(events.filter(event => event.type === 'turn_completed')).toEqual([
        expect.objectContaining({ nativeAssistantId: 'assistant-2' }),
      ]);
      expect(sessionEvents.some(event => event.type === 'background_turn_started')).toBe(false);
      expect(session.getStatus()).toBe('idle');
    } finally {
      await session.dispose();
    }
  });

  it('accepts a steer Claude consumed without replaying it', async () => {
    const { session, events, done } = await startSteerableSession(async function* (nextInput, keepOpen) {
      const prompt = await nextInput();
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      yield assistantText('assistant-1', 'Working.');
      const steer = await nextInput();
      yield { type: 'result', subtype: 'success', user_message_uuids: [prompt.uuid, steer.uuid], queued_turn_count: 0 };
      await keepOpen;
    });
    try {
      await waitFor(() => events.some(event => event.type === 'text_delta'));
      await expect(session.steer(steerRequest('Be brief'))).resolves.toBe(true);
      await done;
      expect(events.at(-1)?.type).toBe('turn_completed');
    } finally {
      await session.dispose();
    }
  });

  it('rejects a handed-off steer whose delivery ends unknown', async () => {
    const { session, events, done } = await startSteerableSession(async function* (nextInput, keepOpen) {
      const prompt = await nextInput();
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      yield assistantText('assistant-1', 'Working.');
      await nextInput();
      yield { type: 'result', subtype: 'success', user_message_uuids: [prompt.uuid], queued_turn_count: 0 };
      await keepOpen;
    });
    try {
      await waitFor(() => events.some(event => event.type === 'text_delta'));
      await expect(session.steer(steerRequest('Be brief'))).rejects.toThrow('before the steer was delivered');
      await done;
      expect(events.at(-1)?.type).toBe('turn_completed');
    } finally {
      await session.dispose();
    }
  });

  it('recalls an undelivered steer on cancel by replacing the native process', async () => {
    const retryQuery = createScriptedPersistentQuery([[
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      assistantText('assistant-retry', 'Fresh process.'),
      { type: 'result', subtype: 'success' },
    ]]);
    const steerQueued = createDeferred<null>();
    const { session, run, events, done, loadQuery, getQuery } = await startSteerableSession(async function* (nextInput, keepOpen) {
      await nextInput();
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      yield assistantText('assistant-1', 'Running a long command.');
      await nextInput();
      steerQueued.resolve(null);
      await keepOpen;
    });
    loadQuery.mockResolvedValueOnce((() => retryQuery) as never);
    try {
      await waitFor(() => events.some(event => event.type === 'text_delta'));
      const steer = session.steer(steerRequest('Stop after this'));
      await steerQueued.promise;
      run.cancel();
      await expect(steer).rejects.toThrow('before the steer was delivered');
      await done;
      expect(events.at(-1)?.type).toBe('cancelled');

      const retryEvents = await collectEvents(session.execute(createRequest()).events);
      expect(loadQuery).toHaveBeenCalledTimes(2);
      expect(getQuery()?.interrupt).toHaveBeenCalled();
      expect(retryEvents.at(-1)?.type).toBe('turn_completed');
    } finally {
      await session.dispose();
    }
  });

  it('declines steering without a live persistent native turn', async () => {
    const idle = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
    await expect(idle.steer(steerRequest('Too early'))).resolves.toBe(false);
    await idle.dispose();

    const { session, events, done } = await startSteerableSession(async function* (nextInput, keepOpen) {
      await nextInput();
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      yield assistantText('assistant-1', 'Working.');
      yield { type: 'result', subtype: 'success' };
      await keepOpen;
    }, { lifecycle: 'ephemeral', nativePersistence: 'enabled' });
    try {
      await waitFor(() => events.some(event => event.type === 'text_delta'));
      const accepted = await session.steer(steerRequest('Ephemeral'));
      await done;
      expect(accepted).toBe(false);
    } finally {
      await session.dispose();
    }
  });
});

function replayOf(message: sdkModule.SDKUserMessage): unknown {
  return { ...message, isReplay: true, session_id: 'session-1' };
}

function assistantText(uuid: string, text: string): unknown {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { id: `message-${uuid}`, content: [{ type: 'text', text }] },
  };
}

function createInputDrivenQuery(
  prompt: AsyncIterable<sdkModule.SDKUserMessage>,
  script: (nextInput: () => Promise<sdkModule.SDKUserMessage>) => AsyncGenerator<unknown>,
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

it('preserves the main checkpoint when an async child finishes during automatic output', async () => {
  const keepOpen = createDeferred<unknown>();
  const query = createScriptedPersistentQuery([[
    { type: 'system', subtype: 'init', session_id: 'session-1' },
    { type: 'result', subtype: 'success' },
    { type: 'assistant', uuid: 'main-checkpoint', parent_tool_use_id: null,
      message: { id: 'main-message', content: [{ type: 'text', text: 'Automatic answer' }] } },
    { type: 'assistant', uuid: 'child-checkpoint', parent_tool_use_id: 'async-agent',
      message: { id: 'child-message', content: [{ type: 'text', text: 'Child answer' }] } },
    { type: 'result', subtype: 'success' },
    keepOpen.promise,
  ]]);
  jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
    .mockResolvedValueOnce((() => query) as never);
  const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
  const background: ProviderSessionEvent[] = [];
  session.onEvent(event => background.push(event));
  try {
    await collectEvents(session.execute(createRequest()).events);
    await waitFor(() => background.some(event => event.type === 'background_turn_completed'));
    expect(background.find(event => event.type === 'background_turn_completed'))
      .toMatchObject({ nativeAssistantId: 'main-checkpoint' });
  } finally {
    keepOpen.resolve(null);
    await session.dispose();
    jest.restoreAllMocks();
  }
});

it.each([false, true])('anchors session notifications after emitted events with native turn completed=%s', async completed => {
  const keepOpen = createDeferred<unknown>();
  const query = createScriptedPersistentQuery([[
    { type: 'system', subtype: 'init', session_id: 'session-1' },
    { type: 'assistant', uuid: 'before-checkpoint', message: { id: 'before', content: [{ type: 'text', text: 'Before notification' }] } },
    ...(completed ? [{ type: 'result', subtype: 'success' }] : []),
    { type: 'system', subtype: 'task_notification', task_id: 'task', session_id: 'session-1', status: 'completed', summary: 'Task finished', uuid: 'notification' },
    consumedTaskNotification(),
    ...(!completed ? [{ type: 'result', subtype: 'success' }] : []),
    keepOpen.promise,
  ]]);
  jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
    .mockResolvedValueOnce((() => query) as never);
  const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
  const sessionEvents: ProviderSessionEvent[] = [];
  session.onEvent(event => sessionEvents.push(event));
  try {
    const events = await collectEvents(session.execute(createRequest()).events);
    const text = events.find(event => event.type === 'text_delta');
    expect(text).toMatchObject({ text: 'Before notification' });
    await waitFor(() => sessionEvents.some(event => event.type === 'task_notification'));
    expect(sessionEvents.find(event => event.type === 'task_notification'))
      .toMatchObject({ afterRequestedEvent: completed ? events.at(-1)?.scope : text?.scope });
  } finally {
    keepOpen.resolve(null);
    await session.dispose();
    jest.restoreAllMocks();
  }
});

it.each([false, true])('anchors notifications after automatic events with native turn completed=%s', async completed => {
  const keepOpen = createDeferred<unknown>();
  const query = createScriptedPersistentQuery([[
    { type: 'system', subtype: 'init', session_id: 'session-1' },
    { type: 'result', subtype: 'success' },
    { type: 'assistant', uuid: 'automatic-checkpoint', message: { id: 'automatic', content: [{ type: 'text', text: 'Automatic answer' }] } },
    ...(completed ? [{ type: 'result', subtype: 'success' }] : []),
    { type: 'system', subtype: 'task_notification', task_id: 'task', session_id: 'session-1', status: 'completed', summary: 'Task finished', uuid: 'notification' },
    consumedTaskNotification(),
    ...(!completed ? [{ type: 'result', subtype: 'success' }] : []),
    keepOpen.promise,
  ]]);
  jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
    .mockResolvedValueOnce((() => query) as never);
  const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
  const events: ProviderSessionEvent[] = [];
  session.onEvent(event => events.push(event));
  try {
    await collectEvents(session.execute(createRequest()).events);
    await waitFor(() => events.some(event => event.type === 'task_notification'));
    const predecessor = events.find(event => event.type === (completed ? 'background_turn_completed' : 'text_delta'));
    expect(predecessor?.scope.kind).toBe('background');
    expect(events.find(event => event.type === 'task_notification')).toMatchObject({ afterBackgroundEvent: predecessor?.scope });
  } finally {
    keepOpen.resolve(null);
    await session.dispose();
    jest.restoreAllMocks();
  }
});

it.each(['mid-turn', 'next-turn-echo', 'next-turn-no-echo'])('places a consumed task notification at its native boundary (%s)', async delivery => {
  const midTurn = delivery === 'mid-turn';
  const historyDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-notification-order-'));
  const completed = createDeferred<unknown>();
  const keepOpen = createDeferred<unknown>();
  const notification = '<task-notification><task-id>task</task-id><status>completed</status><summary>Task finished</summary></task-notification>';
  const answer = { type: 'assistant', uuid: 'answer', message: { id: 'answer', content: [{ type: 'text', text: 'Requested answer' }] } };
  const consumed = { type: 'user', uuid: 'consumed', parent_tool_use_id: null, isSynthetic: true,
    ...(midTurn ? { isReplay: true } : {}), message: { role: 'user', content: notification } };
  const query = createScriptedPersistentQuery([[
    { type: 'system', subtype: 'init', session_id: 'session-1' },
    { type: 'system', subtype: 'task_notification', session_id: 'session-1', task_id: 'task', status: 'completed', summary: 'Task finished' },
    completed.promise,
    ...(midTurn ? [consumed, answer] : [answer]),
    { type: 'result', subtype: 'success' },
    ...(!midTurn ? [
      // The real late trace completes the child's Bash after the requested result.
      { type: 'user', parent_tool_use_id: 'async-agent', message: { content: [{ type: 'tool_result', tool_use_id: 'child-bash', content: '(Bash completed with no output)' }] } },
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      ...(delivery === 'next-turn-echo' ? [consumed] : []),
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'followup', usage: {} } } },
      { type: 'assistant', message: { id: 'followup', content: [{ type: 'text', text: 'Automatic follow-up' }] } },
      { type: 'result', subtype: 'success' }] : []),
    keepOpen.promise,
  ]]);
  jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
    .mockResolvedValueOnce((() => query) as never);
  const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
  const sessionEvents: ProviderSessionEvent[] = [];
  const order: string[] = [];
  session.onEvent(event => {
    sessionEvents.push(event);
    if (event.type === 'task_notification') order.push(event.content);
    if (event.type === 'text_delta') order.push(event.text);
  });
  const requested = (async () => {
    for await (const event of session.execute(createRequest()).events) {
      if (event.type === 'text_delta') order.push(event.text);
    }
  })();
  try {
    await waitFor(() => sessionEvents.some(event => event.type === 'async_subagent_completed'));
    expect(sessionEvents.filter(event => event.type === 'task_notification')).toEqual([]);
    completed.resolve(null);
    await requested;
    await waitFor(() => sessionEvents.some(event => event.type === 'task_notification'));
    if (!midTurn) await waitFor(() => sessionEvents.some(event => event.type === 'background_turn_completed'));
    expect(order).toEqual(midTurn ? ['Task finished', 'Requested answer']
      : ['Requested answer', 'Task finished', 'Automatic follow-up']);
    // Native JSONL records consumption as a queued attachment mid-turn, or a
    // user message starting the automatic turn. It never records the SDK edge.
    const historyNotification = midTurn
      ? { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notification } }
      : { type: 'user', message: { content: notification } };
    const transcript = [
      { type: 'user', message: { content: 'Hello' } },
      ...(midTurn ? [historyNotification, answer] : [answer, historyNotification,
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Automatic follow-up' }] } }]),
    ].map((entry, index) => ({ ...entry, uuid: `entry-${index}`, parentUuid: index ? `entry-${index - 1}` : null,
      timestamp: testTime({ seconds: index }) }));
    const historyPath = path.join(historyDirectory, 'session.jsonl');
    await fs.writeFile(historyPath, transcript.map(entry => JSON.stringify(entry)).join('\n'));
    const replay = await historyStore.loadSDKSessionMessages('/vault', 'session-1', undefined, historyPath);
    expect(replay.error).toBeUndefined();
    const replayOrder = replay.messages.filter(message => message.role === 'assistant')
      .flatMap(message => message.contentBlocks ?? [])
      .flatMap(block => block.type === 'text' || block.type === 'task_notification' ? [block.content] : []);
    expect(order).toEqual(replayOrder);

    expect(sessionEvents.filter(event => event.type === 'task_notification')).toHaveLength(1);
  } finally {
    completed.resolve(null); keepOpen.resolve(null);
    await requested; await session.dispose(); jest.restoreAllMocks();
    await fs.rm(historyDirectory, { recursive: true, force: true });
  }
});

function consumedTaskNotification(taskId = 'task') {
  return { type: 'user', uuid: 'notification-consumed', parent_tool_use_id: null, isReplay: true, isSynthetic: true,
    message: { role: 'user', content: `<task-notification><task-id>${taskId}</task-id><status>completed</status><summary>Task finished</summary></task-notification>` } };
}

it.each([
  { name: 'foreground', background: false, expected: false },
  { name: 'background transition', background: false, transition: true, expected: true },
  { name: 'background', background: true, expected: true },
  { name: 'ambient', background: true, skip: true, expected: false },
  { name: 'replacement query', background: true, replacement: true, expected: false },
  { name: 'interrupt with a surviving queue', background: true, cancel: true, expected: true },
])('filters queued completion presentation for $name', async scenario => {
  const session = new ClaudeExecutionSession(createHost(), createConfig());
  const events: ProviderSessionEvent[] = [];
  session.onEvent(event => events.push(event));
  try {
    if (scenario.cancel) await session.handleNativeMessage({ type: 'assistant', message: { id: 'before', content: [{ type: 'text', text: 'Before cancellation' }] } } as any, 1);
    await session.handleNativeMessage({ type: 'system', subtype: 'task_started', task_id: 'task', is_backgrounded: scenario.background } as any, 1);
    if (scenario.transition) await session.handleNativeMessage({ type: 'system', subtype: 'task_updated', task_id: 'task', patch: { is_backgrounded: true } } as any, 1);
    await session.handleNativeMessage({ type: 'system', subtype: 'task_notification', session_id: 'session-1',
      task_id: 'task', status: 'completed', summary: 'Task result', skip_transcript: scenario.skip } as any, 1);
    expect(events.filter(event => event.type === 'task_notification')).toHaveLength(0);
    expect(events.filter(event => event.type === 'async_subagent_completed')).toHaveLength(1);
    if (scenario.cancel) {
      session.cancel();
      await session.handleNativeMessage({ type: 'result', subtype: 'success' } as any, 1);
    }
    if (scenario.replacement) session.handleNativeQueryOpened({} as sdkModule.Query);
    await session.handleNativeMessage({ type: 'system', subtype: 'init', session_id: 'session-1' } as any, scenario.replacement ? 2 : 1);
    await session.handleNativeMessage({ type: 'assistant', message: { id: 'after', content: [{ type: 'text', text: 'Automatic output' }] } } as any, scenario.replacement ? 2 : 1);
    const expected = scenario.expected ? ['Task result'] : [];
    expect(events.filter(event => event.type === 'task_notification').map(event => event.content)).toEqual(expected);
  } finally { await session.dispose(); }
});

it('keeps task notification state across requested turns of one persistent query', async () => {
  let sends = 0;
  jest.spyOn(await import('@/providers/claude/loadClaudeAgentSDK'), 'loadClaudeAgentQuery')
    .mockResolvedValueOnce(((params: { prompt: AsyncIterable<sdkModule.SDKUserMessage> }) =>
      createPromptDrivenPersistentQuery(params.prompt, () => ++sends === 1 ? [
        { type: 'system', subtype: 'init', session_id: 'session-1' },
        { type: 'system', subtype: 'task_started', task_id: 'foreground', is_backgrounded: false },
        { type: 'system', subtype: 'task_started', task_id: 'background', is_backgrounded: true },
        { type: 'result', subtype: 'success' },
      ] : [
        { type: 'system', subtype: 'init', session_id: 'session-1' },
        { type: 'system', subtype: 'task_notification', session_id: 'session-1', task_id: 'foreground', status: 'completed', summary: 'Foreground result' },
        { type: 'system', subtype: 'task_notification', session_id: 'session-1', task_id: 'background', status: 'completed', summary: 'Background result' },
        { type: 'assistant', message: { id: 'requested', content: [{ type: 'text', text: 'Second requested answer' }] } },
        { type: 'result', subtype: 'success' },
        { type: 'system', subtype: 'init', session_id: 'session-1' },
        { type: 'assistant', message: { id: 'automatic', content: [{ type: 'text', text: 'Automatic answer' }] } },
        { type: 'result', subtype: 'success' },
      ])) as never);
  const session = new ClaudeExecutionBackend(createHost()).createSession(createConfig());
  const events: ProviderSessionEvent[] = [];
  session.onEvent(event => events.push(event));
  try {
    await collectEvents(session.execute(createRequest()).events);
    await collectEvents(session.execute(createRequest()).events);
    await waitFor(() => events.some(event => event.type === 'background_turn_completed'));
    expect(events.filter(event => event.type === 'task_notification')).toEqual([
      expect.objectContaining({ content: 'Background result' }),
    ]);
  } finally { await session.dispose(); jest.restoreAllMocks(); }
});

it('keeps a completion during automatic request startup for the following turn', async () => {
  const session = new ClaudeExecutionSession(createHost(), createConfig());
  const order: string[] = [];
  session.onEvent(event => {
    if (event.type === 'task_notification') order.push(event.content);
    if (event.type === 'text_delta') order.push(event.text);
  });
  try {
    // Captured SDK order: A completes, automatic init, B completes, first A chunk.
    for (const message of [
      { type: 'system', subtype: 'task_notification', session_id: 'session-1', task_id: 'a', status: 'completed', summary: 'FIRST_DONE' },
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'system', subtype: 'task_notification', session_id: 'session-1', task_id: 'b', status: 'completed', summary: 'SECOND_DONE' },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'first', usage: {} } } },
      { type: 'assistant', message: { id: 'first', content: [{ type: 'text', text: 'First automatic answer' }] } },
      { type: 'result', subtype: 'success' },
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'assistant', message: { id: 'second', content: [{ type: 'text', text: 'Second automatic answer' }] } },
      { type: 'result', subtype: 'success' },
    ]) await session.handleNativeMessage(message as any, 1);
    expect(order).toEqual(['FIRST_DONE', 'First automatic answer', 'SECOND_DONE', 'Second automatic answer']);
  } finally { await session.dispose(); }
});
