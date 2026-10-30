import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import compactCompleted from '@test/fixtures/providers/grok/runtime/compaction-completed.json';
import turnCompleted from '@test/fixtures/providers/grok/runtime/turn-completed.json';
import { capturedSelectionPrompt, capturedSelections } from '@test/helpers/capturedSelections';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { GrokNativeProcess } from '@test/helpers/providers/grok/GrokNativeProcess';
import { writeGrokCatalog } from '@test/helpers/providers/grokSettings';
import { grokWSLToolUpdates } from '@test/helpers/providers/grokWSLTools';
import { testDate } from '@test/helpers/testClock';
import { readWSLExec } from '@test/helpers/WSLLaunch';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderExecutionSession,
  ProviderInteractionPort, ProviderSessionConfig } from '@/core/execution';
import { isRewindableExecutionSession } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ClaudianSettings } from '@/core/types';
import { GrokExecutionBackend, type GrokExecutionBackendOptions } from '@/providers/grok/execution/GrokExecutionBackend';
import { encodeGrokSessionCwd } from '@/providers/grok/history/GrokHistoryPathResolver';
import { updateGrokProviderSettings } from '@/providers/grok/settings';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

interface GrokProcessFactory { create(): GrokNativeProcess; }
const sessions: ProviderExecutionSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  vi.mocked(spawn).mockReset();
});

function createBackend(host: ProviderHost, options: { processFactory: GrokProcessFactory }) {
  vi.mocked(spawn).mockImplementation(() => options.processFactory.create().child);
  const backend = new GrokExecutionBackend(host.getRuntimeHost('grok'));
  return {
    createSession(config: ProviderSessionConfig) {
      const session = backend.createSession(config);
      sessions.push(session);
      return session;
    },
  };
}

async function createGrokHost(model = 'grok-4', settings: Partial<ClaudianSettings> = {}) {
  const { host } = await createProviderHostFixture({
    overrides: { getResolvedProviderCliPath: async () => 'grok' },
    settings: { ...settings, model: `grok/${model}`, providerConfigs: { grok: { enabled: true, visibleModels: [model, 'grok-3'] } } },
  });
  writeGrokCatalog(host.settings, { defaultModelId: model, fingerprint: 'fixture', refreshedAt: 1,
    models: [{ rawId: 'grok-3', displayName: 'Grok 3', supportsReasoning: false, reasoningEfforts: [] },
      { rawId: model, displayName: model, supportsReasoning: true, reasoningEfforts: [] }] });
  return host;
}

const interactionPort: ProviderInteractionPort = {
  askUserQuestion: vi.fn(),
  dismissInteraction: vi.fn(),
  requestApproval: vi.fn(),
};

const sessionConfig: ProviderSessionConfig = {
  interactionPort,
  lifecycle: 'persistent',
  nativePersistence: 'enabled',
  resumeSeed: {
    providerSessionId: 'session-existing',
    providerState: { sessionDirectory: '/tmp/grok-session' },
  },
  workingDirectory: '/tmp/vault',
};

function executionRequest(text = 'hello'): ProviderExecutionRequest {
  return {
    configuration: {
      permissionMode: 'normal',
      model: 'grok/grok-4',
      reasoning: 'high',
      systemInstructions: { kind: 'explicit', instructions: 'Be exact.' },
    },
    input: [{ text, type: 'text' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
  };
}

async function collect(events: AsyncIterable<ProviderExecutionEvent>): Promise<ProviderExecutionEvent[]> {
  const collected: ProviderExecutionEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

it.each(['', 'Inspect these images'])('sends native ACP image blocks with text %j', async text => {
  const native = new GrokNativeProcess();
  const session = createBackend(await createGrokHost(), {
    processFactory: { create: () => native },
  }).createSession(sessionConfig);
  try {
    const events = await collect(session.execute({
      ...executionRequest(text),
      input: [
        ...(text ? [{ type: 'text' as const, text }] : []),
        {
          type: 'image',
          image: { id: 'image-1', name: 'first.png', mediaType: 'image/png', data: 'aGVsbG8=', size: 5, source: 'paste' },
        },
        {
          type: 'image',
          image: { id: 'image-2', name: 'second.webp', mediaType: 'image/webp', data: 'd29ybGQ=', size: 5, source: 'drop' },
        },
      ],
    }).events);
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(native.promptRequests).toEqual([expect.objectContaining({
      prompt: [
        ...(text ? [{ type: 'text', text }] : []),
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        { type: 'image', mimeType: 'image/webp', data: 'd29ybGQ=' },
      ],
    })]);
  } finally {
    await session.dispose();
  }
});

it.each([
  ['/compact', '/compact'],
  [' \t/CoMpAcT keep recent edits\nFocus on tests  ', '/compact keep recent edits\nFocus on tests'],
])('compacts with only explicit instructions from %j', async (text, command) => {
  const native = new GrokNativeProcess();
  const session = createBackend(await createGrokHost(), {
    processFactory: { create: () => native },
  }).createSession(sessionConfig);
  try {
    const events = await collect(session.execute({
      ...executionRequest(text),
      input: [{ type: 'text', text }, { type: 'image', image: {
        id: 'capture', name: 'capture.png', data: 'aW1hZ2U=',
        mediaType: 'image/png', size: 5, source: 'paste',
      } }],
      context: { ...capturedSelections, linkedContent: { path: 'note.md' },
        sessionReferences: [{ id: 'ref', title: 'Review', providerId: 'grok', updatedAt: 'updated' }],
      },
    }).events);
    expect(native.promptRequests).toEqual([{ sessionId: 'session-existing', prompt: [{ type: 'text', text: command }] }]);
    expect(events.at(-1)?.type).toBe('turn_completed');
  } finally { await session.dispose(); }
});

it.each(['auto_compact_completed', 'auto_compact_failed', 'auto_compact_cancelled'])(
  'maps native %s to a success divider only when completed', async sessionUpdate => {
    const native = new GrokNativeProcess();
    native.promptImplementation = async () => {
      const update = { ...compactCompleted.params.update, sessionUpdate };
      native.emit(update, 'extension', compactCompleted.params._meta);
      native.emit(update, 'standard', compactCompleted.params._meta);
      return { stopReason: 'end_turn' };
    };
    const session = createBackend(await createGrokHost(), {
      processFactory: { create: () => native },
    }).createSession(sessionConfig);
    try {
      const events = await collect(session.execute(executionRequest('/compact')).events);
      expect(events.filter(event => event.type === 'context_compacted')).toHaveLength(sessionUpdate === 'auto_compact_completed' ? 1 : 0);
      expect(events.at(-1)?.type).toBe('turn_completed');
    } finally { await session.dispose(); }
  },
);

it('preserves standard Grok message IDs across assistant messages', async () => {
  const native = new GrokNativeProcess();
  native.promptImplementation = async () => {
    for (const id of ['assistant-first', 'assistant-final']) {
      native.emit({
        content: { text: id, type: 'text' },
        messageId: id,
        sessionUpdate: 'agent_message_chunk',
      }, 'extension');
    }
    return { stopReason: 'end_turn' };
  };
  const session = createBackend(await createGrokHost(), {
    processFactory: { create: () => native },
  }).createSession(sessionConfig);
  try {
    const events = await collect(session.execute(executionRequest()).events);
    expect(events.filter(event => event.type === 'assistant_message_started')).toEqual([
      expect.objectContaining({ nativeAssistantId: 'assistant-first' }),
      expect.objectContaining({ nativeAssistantId: 'assistant-final' }),
    ]);
  } finally {
    await session.dispose();
  }
});

it.each(['notification', 'update'] as const)(
  'keeps per-token Grok chunks from %s metadata in one assistant message keyed by prompt ID',
  async location => {
    // Grok assigns a fresh eventId to every streamed token; only promptId is stable per turn.
    const native = new GrokNativeProcess();
    native.promptImplementation = async () => {
      ['Hello', ',', ' world'].forEach((text, index) => {
        const metadata = { eventId: `event-${index}`, promptId: 'prompt-1' };
        native.emit({
          content: { text, type: 'text' },
          sessionUpdate: 'agent_message_chunk',
          ...(location === 'update' ? { _meta: metadata } : {}),
        }, 'extension', location === 'notification' ? metadata : undefined);
      });
      return { stopReason: 'end_turn' };
    };
    const session = createBackend(await createGrokHost(), {
      processFactory: { create: () => native },
    }).createSession(sessionConfig);
    try {
      const events = await collect(session.execute(executionRequest()).events);
      expect(events.filter(event => event.type === 'assistant_message_started')).toEqual([
        expect.objectContaining({ nativeAssistantId: 'prompt-1' }),
      ]);
      expect(events.flatMap(event => (event.type === 'text_delta' ? [event.text] : [])).join(''))
        .toBe('Hello, world');
    } finally {
      await session.dispose();
    }
  },
);

it.each(['notification', 'response', 'metadata'] as const)(
  'emits final Grok usage from %s with the streamed context window',
  async source => {
    const fixture = turnCompleted;
    const update = fixture.params.params.update;
    const native = new GrokNativeProcess();
    native.promptImplementation = async () => {
      native.emit({ sessionUpdate: 'usage_update', size: 200_000, used: 12 });
      if (source === 'notification') native.emit(update, 'extension');
      return {
        stopReason: 'end_turn',
        ...(source === 'response' ? { usage: update.usage } : {}),
        ...(source === 'metadata' ? { _meta: { usage: update.usage } } : {}),
      };
    };
    const session = createBackend(await createGrokHost(), {
      processFactory: { create: () => native },
    }).createSession(sessionConfig);
    try {
      const events = await collect(session.execute(executionRequest()).events);
      expect(events.filter(event => event.type === 'usage_updated').at(-1)).toMatchObject({
        usage: {
          inputTokens: 10327, cacheReadInputTokens: 1280, contextTokens: 10377,
          contextWindow: 200_000, percentage: 5,
        },
      });
    } finally {
      await session.dispose();
    }
  },
);

it('loads the fixed native session, configures model/mode, and streams correlated ACP output', async () => {
  const native = new GrokNativeProcess();
  native.promptImplementation = async () => {
    native.emit({
      content: { text: 'answer', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    return { stopReason: 'end_turn' };
  };
  const processFactory: GrokProcessFactory = { create: vi.fn(() => native) };
  const backend = createBackend(await createGrokHost(), { processFactory });
  const session = backend.createSession(sessionConfig);

  const run = session.execute(executionRequest());
  const events = await collect(run.events);

  expect(native.loadRequests).toHaveLength(1);
  expect(native.modelRequests[0]).toEqual({
    _meta: { reasoningEffort: 'high' },
    modelId: 'grok-4',
    sessionId: 'session-existing',
  });
  expect(native.modeRequests[0]).toEqual({ modeId: 'default', sessionId: 'session-existing' });
  expect(native.promptRequests[0]).toMatchObject({
    prompt: [{ text: 'hello', type: 'text' }],
    sessionId: 'session-existing',
  });
  expect(events.map(event => event.type)).toEqual([
    'session_state_changed',
    'session_state_changed',
    'turn_started',
    'assistant_message_started',
    'text_delta',
    'session_state_changed',
    'turn_completed',
  ]);
  expect(events.every(event => event.scope.executionId === run.executionId)).toBe(true);
  expect(events.map(event => event.scope.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(events.filter(event => event.type === 'session_state_changed')).toEqual([
    expect.objectContaining({
      snapshot: expect.objectContaining({
        providerSessionId: 'session-existing',
        status: 'executing',
      }),
    }),
    expect.objectContaining({
      snapshot: expect.objectContaining({
        providerSessionId: 'session-existing',
        status: 'executing',
      }),
    }),
    expect.objectContaining({
      snapshot: expect.objectContaining({
        providerSessionId: 'session-existing',
        status: 'idle',
      }),
    }),
  ]);
  expect(session.getSnapshot()).toMatchObject({
    providerSessionId: 'session-existing',
    status: 'idle',
  });
});

it('encodes path-only Linked content without changing the Vault-root session CWD', async () => {
  const native = new GrokNativeProcess();
  const processFactory: GrokProcessFactory = { create: vi.fn(() => native) };
  const session = createBackend(
    await createGrokHost(),
    { processFactory },
  ).createSession(sessionConfig);
  const baseRequest = executionRequest('Inspect linked content');

  await collect(session.execute({
    ...baseRequest,
    context: { ...capturedSelections, sessionReferences: [{ id: 'conv-1-ref', title: 'Review', providerId: 'codex', updatedAt: 'updated' }], linkedContent: { path: 'Projects/Research' } },
  }).events);

  expect(native.loadRequests[0]?.cwd).toBe('/tmp/vault');
  expect(native.promptRequests[0]?.prompt).toEqual([{
    text: 'Inspect linked content\n\n<linked_content path="Projects/Research" />\n\n' + capturedSelectionPrompt + '\n\n<context_sessions>\n<context_session title="Review" id="conv-1-ref" provider="codex" updated="updated" />\n</context_sessions>',
    type: 'text',
  }]);
  expect(JSON.stringify(native.promptRequests[0]?.prompt)).not.toMatch(
    /<(?:linked_note|current_note)\b/,
  );
});

it('loads once per native connection and quarantines session replay from live output', async () => {
  const native = new GrokNativeProcess();
  native.loadImplementation = async request => {
    native.emit({
      content: { text: 'historical replay', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    return { sessionId: request.sessionId };
  };
  native.promptImplementation = async () => {
    native.emit({
      content: { text: 'live answer', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    return { stopReason: 'end_turn' };
  };
  const session = createBackend(
    await createGrokHost(),
    { processFactory: { create: () => native } },
  ).createSession(sessionConfig);

  const firstEvents = await collect(session.execute(executionRequest('first')).events);
  const secondEvents = await collect(session.execute(executionRequest('second')).events);

  expect(native.loadRequests).toHaveLength(1);
  expect(firstEvents.filter(event => event.type === 'text_delta')).toEqual([
    expect.objectContaining({ text: 'live answer' }),
  ]);
  expect(secondEvents.filter(event => event.type === 'text_delta')).toEqual([
    expect.objectContaining({ text: 'live answer' }),
  ]);
});

it('keeps one loaded connection for dynamic model changes', async () => {
  const native = new GrokNativeProcess();
  const processFactory: GrokProcessFactory = {
    create: vi.fn(() => native),
  };
  const session = createBackend(
    await createGrokHost(),
    { processFactory },
  ).createSession(sessionConfig);
  const firstRequest = executionRequest('first');
  const secondRequest: ProviderExecutionRequest = {
    ...executionRequest('second'),
    configuration: {
      ...firstRequest.configuration,
      model: 'grok/grok-3',
    },
  };

  await collect(session.execute(firstRequest).events);
  await collect(session.execute(secondRequest).events);

  expect(processFactory.create).toHaveBeenCalledTimes(1);
  expect(native.loadRequests).toHaveLength(1);
  expect(native.modelRequests.map(request => request.modelId)).toEqual([
    'grok-4',
    'grok-3',
  ]);
  expect(native.modeRequests.map(request => request.modeId)).toEqual([
    'default',
    'default',
  ]);
});

it('reconnects and loads once when load-scoped session metadata changes', async () => {
  const firstNative = new GrokNativeProcess();
  const secondNative = new GrokNativeProcess();
  const processFactory: GrokProcessFactory = {
    create: vi.fn()
      .mockReturnValueOnce(firstNative)
      .mockReturnValueOnce(secondNative),
  };
  const session = createBackend(
    await createGrokHost(),
    { processFactory },
  ).createSession(sessionConfig);
  const firstRequest = executionRequest('first');
  const secondRequest: ProviderExecutionRequest = {
    ...executionRequest('second'),
    configuration: {
      ...firstRequest.configuration,
      systemInstructions: { kind: 'explicit', instructions: 'Use the replacement policy.' },
    },
  };

  await collect(session.execute(firstRequest).events);
  await collect(session.execute(secondRequest).events);

  expect(processFactory.create).toHaveBeenCalledTimes(2);
  expect(firstNative.loadRequests).toHaveLength(1);
  expect(firstNative.shutdownCalls).toBe(1);
  expect(secondNative.loadRequests).toEqual([
    expect.objectContaining({
      _meta: expect.objectContaining({
        systemPromptOverride: 'Use the replacement policy.',
      }),
      sessionId: 'session-existing',
    }),
  ]);
});

it('sends the caller-resolved Main Agent prompt as the full Grok prompt replacement', async () => {
  const native = new GrokNativeProcess();
  const host = await createGrokHost('grok-4', { systemPrompt: 'Base system prompt', userName: 'Ada' });

  const session = createBackend(host, {
    processFactory: { create: () => native },
  }).createSession(sessionConfig);
  const base = executionRequest();
  const request = {
    ...base,
    configuration: {
      ...base.configuration,
      systemInstructions: { kind: 'main-agent' as const, instructions: 'Caller-resolved Main Agent prompt.' },
    },
  };

  await collect(session.execute(request).events);

  expect(native.loadRequests[0]?._meta?.systemPromptOverride).toBe('Caller-resolved Main Agent prompt.');
});

it('reloads with the replacement prompt when the Main Agent instructions change', async () => {
  const firstNative = new GrokNativeProcess();
  const secondNative = new GrokNativeProcess();
  const processFactory: GrokProcessFactory = {
    create: vi.fn()
      .mockReturnValueOnce(firstNative)
      .mockReturnValueOnce(secondNative),
  };
  const session = createBackend(await createGrokHost(), { processFactory }).createSession(sessionConfig);
  const withSession = (text: string, instructions: string): ProviderExecutionRequest => {
    const base = executionRequest(text);
    return {
      ...base,
      configuration: { ...base.configuration, systemInstructions: { kind: 'main-agent', instructions } },
    };
  };

  await collect(session.execute(withSession('first', 'Main Agent prompt Alpha')).events);
  await collect(session.execute(withSession('second', 'Main Agent prompt Alpha')).events);
  expect(processFactory.create).toHaveBeenCalledTimes(1);
  expect(firstNative.loadRequests[0]?._meta?.systemPromptOverride).toBe('Main Agent prompt Alpha');

  await collect(session.execute(withSession('third', 'Main Agent prompt Beta')).events);
  expect(processFactory.create).toHaveBeenCalledTimes(2);
  expect(secondNative.loadRequests[0]?._meta?.systemPromptOverride).toBe('Main Agent prompt Beta');
});

it('bootstraps canonical history only when creating a new native session', async () => {
  const native = new GrokNativeProcess();
  const session = createBackend(
    await createGrokHost(),
    { processFactory: { create: () => native } },
  ).createSession({
    ...sessionConfig,
    resumeSeed: undefined,
  });
  const request = {
    ...executionRequest('current'),
    conversationHistory: [
      { content: 'prior question', id: 'user-prior', role: 'user' as const, timestamp: 1 },
      { content: 'prior answer', id: 'assistant-prior', role: 'assistant' as const, timestamp: 2 },
    ],
  };

  await collect(session.execute(request).events);
  await collect(session.execute(request).events);

  expect(native.newRequests).toHaveLength(1);
  expect(native.promptRequests[0]?.prompt).toEqual([
    expect.objectContaining({
      text: expect.stringContaining('prior question'),
      type: 'text',
    }),
  ]);
  expect(JSON.stringify(native.promptRequests[0]?.prompt)).toContain('prior answer');
  expect(JSON.stringify(native.promptRequests[1]?.prompt)).not.toContain('prior question');
  expect(JSON.stringify(native.promptRequests[1]?.prompt)).not.toContain('prior answer');
});

it('persists pending cold-history replay across execution-session recreation', async () => {
  const firstNative = new GrokNativeProcess();
  firstNative.modelImplementation = async () => {
    throw new Error('model configuration failed before prompt handoff');
  };
  const backend = createBackend(
    await createGrokHost(),
    { processFactory: { create: () => firstNative } },
  );
  const firstSession = backend.createSession({
    ...sessionConfig,
    resumeSeed: undefined,
  });
  const request = {
    ...executionRequest('current'),
    conversationHistory: [
      { content: 'durable prior', id: 'user-prior', role: 'user' as const, timestamp: 1 },
    ],
  };

  await collect(firstSession.execute(request).events);
  const pendingSnapshot = firstSession.getSnapshot();

  expect(pendingSnapshot).toMatchObject({
    providerSessionId: 'session-new',
    providerState: { nativeConversationContextEstablished: false },
  });
  await firstSession.dispose();

  const secondNative = new GrokNativeProcess();
  const secondSession = createBackend(
    await createGrokHost(),
    { processFactory: { create: () => secondNative } },
  ).createSession({
    ...sessionConfig,
    resumeSeed: {
      providerSessionId: pendingSnapshot.providerSessionId,
      providerState: pendingSnapshot.providerState,
    },
  });

  await collect(secondSession.execute(request).events);

  expect(JSON.stringify(secondNative.promptRequests[0]?.prompt)).toContain('durable prior');
  expect(secondSession.getSnapshot()).toMatchObject({
    providerState: { nativeConversationContextEstablished: true },
  });
});

it('does not bootstrap canonical history when loading native context', async () => {
  const native = new GrokNativeProcess();
  const session = createBackend(
    await createGrokHost(),
    { processFactory: { create: () => native } },
  ).createSession(sessionConfig);

  await collect(session.execute({
    ...executionRequest('current'),
    conversationHistory: [
      { content: 'native-owned prior', id: 'user-prior', role: 'user', timestamp: 1 },
    ],
  }).events);

  expect(JSON.stringify(native.promptRequests[0]?.prompt)).not.toContain('native-owned prior');
});

it('deduplicates mirrored Grok notifications', async () => {
  const native = new GrokNativeProcess();
  native.promptImplementation = async () => {
    const update = {
      content: { text: 'once', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    };
    native.emit(update, 'standard');
    native.emit(update, 'extension');
    return { stopReason: 'end_turn' };
  };
  const session = createBackend(
    await createGrokHost(),
    { processFactory: { create: () => native } },
  ).createSession(sessionConfig);

  const events = await collect(session.execute(executionRequest()).events);

  expect(events.filter(event => event.type === 'text_delta')).toHaveLength(1);
});

it.each([
  {
    rawName: 'read_file', rawInput: { target_file: 'README.md' }, rawOutput: { bytes: 12 },
    name: 'Read', input: { file_path: 'README.md', target_file: 'README.md' },
  },
  {
    rawName: 'use_tool',
    rawInput: { tool_name: 'claudian_sessions__claudian_send_message', tool_input: { text: 'hello' } },
    rawOutput: { type: 'MCP', server_name: 'claudian_sessions', tool_name: 'claudian_send_message', output: { OkayOutput: 'queued' } },
    name: 'claudian_send_message', input: { text: 'hello' },
  },
])('normalizes live $rawName names, inputs, results, and provider payloads like replay', async ({ rawName, rawInput, rawOutput, name, input }) => {
  const native = new GrokNativeProcess();
  native.promptImplementation = async () => {
    native.emit({
      rawInput,
      sessionUpdate: 'tool_call',
      title: rawName,
      toolCallId: 'tool-read',
    });
    native.emit({
      rawOutput,
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      toolCallId: 'tool-read',
    });
    return { stopReason: 'end_turn' };
  };
  const session = createBackend(
    await createGrokHost(),
    { processFactory: { create: () => native } },
  ).createSession(sessionConfig);

  const events = await collect(session.execute(executionRequest()).events);

  expect(events).toContainEqual(expect.objectContaining({
    input,
    name,
    providerPayload: {
      rawInput,
      rawName,
    },
    toolCallId: 'tool-read',
    type: 'tool_started',
  }));
  expect(events).toContainEqual(expect.objectContaining({
    toolCallId: 'tool-read',
    providerPayload: {
      rawInput,
      rawName,
      rawOutput,
    },
    type: 'tool_completed',
  }));
});

it('preserves native overwrite diffs in live Grok tool results', async () => {
  const native = new GrokNativeProcess();
  const rawInput = { content: 'new text', file_path: 'src/write.ts' };
  const rawOutput = { type: 'WriteResult' };
  native.promptImplementation = async () => {
    native.emit({
      rawInput,
      sessionUpdate: 'tool_call',
      title: 'write',
      toolCallId: 'tool-write',
    });
    native.emit({
      content: [{
        newText: 'new text',
        oldText: 'old text',
        path: 'src/write.ts',
        type: 'diff',
      }],
      rawOutput,
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      toolCallId: 'tool-write',
    });
    return { stopReason: 'end_turn' };
  };
  const session = createBackend(
    await createGrokHost(),
    { processFactory: { create: () => native } },
  ).createSession(sessionConfig);

  const events = await collect(session.execute(executionRequest()).events);

  expect(events).toContainEqual(expect.objectContaining({
    toolCallId: 'tool-write',
    resultDetails: {
      diff: {
        filePath: 'src/write.ts',
        diffLines: [
          { type: 'delete', text: 'old text', oldLineNum: 1 },
          { type: 'insert', text: 'new text', newLineNum: 1 },
        ],
        stats: { added: 1, removed: 1 },
      },
    },
    providerPayload: {
      rawInput,
      rawName: 'write',
      rawOutput,
    },
    type: 'tool_completed',
  }));
});

async function createNativeHistory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-backend-history-'));
  const vault = path.join(root, 'vault');
  const host = await createGrokHost();
  updateGrokProviderSettings(host.settings, { environmentVariables: `GROK_HOME=${root}` });
  async function write(sessionId: string, assistantId: string, promptIndex: number) {
    const directory = path.join(root, 'sessions', encodeGrokSessionCwd(vault), sessionId);
    await fs.mkdir(directory, { recursive: true });
    const records = [
      { sessionUpdate: 'user_message_chunk', messageId: 'user-' + promptIndex,
        content: { type: 'text', text: 'Question' }, _meta: { promptIndex } },
      { sessionUpdate: 'agent_message_chunk', messageId: assistantId,
        content: { type: 'text', text: 'Answer' } },
      { sessionUpdate: 'turn_completed' },
    ].map(update => JSON.stringify({ method: 'session/update', params: { sessionId, update }, timestamp: testDate().getTime() / 1000 })).join('\n');
    await fs.writeFile(path.join(directory, 'updates.jsonl'), records);
    return directory;
  }
  return { root, vault, host, write };
}

it('resolves fresh-session rewind through the current target session by default', async () => {
  const history = await createNativeHistory();
  const directory = await history.write('session-new', 'assistant-fresh', 4);
  const native = new GrokNativeProcess();
  const session = createBackend(history.host, { processFactory: { create: () => native } }).createSession({
    ...sessionConfig, resumeSeed: undefined, workingDirectory: history.vault,
  });
  try {
    await collect(session.execute(executionRequest()).events);
    if (!isRewindableExecutionSession(session)) throw new Error('Expected Grok rewind capability.');
    await expect(session.previewRewind('user-1', 'assistant-fresh')).resolves.toMatchObject({ canRewind: true });
    await expect(session.rewind('user-1', 'assistant-fresh')).resolves.toMatchObject({ canRewind: true });
    expect(session.getSnapshot().providerState).toEqual({
      nativeConversationContextEstablished: true, sessionDirectory: directory,
    });
    expect(native.rewindCalls).toEqual([
      { force: false, mode: 'conversation_only', sessionId: 'session-new', targetPromptIndex: 5 },
      { force: true, mode: 'conversation_only', sessionId: 'session-new', targetPromptIndex: 5 },
    ]);
  } finally {
    await session.dispose();
    await fs.rm(history.root, { recursive: true, force: true });
  }
});

it('forks from provider-owned checkpoint metadata and loads the child with system instructions', async () => {
  const history = await createNativeHistory();
  const source = await history.write('session-source', 'assistant-source', 2);
  const child = await history.write('session-forked', 'assistant-target', 5);
  const native = new GrokNativeProcess();
  const session = createBackend(history.host, { processFactory: { create: () => native } }).createSession({
    ...sessionConfig, workingDirectory: history.vault,
    resumeSeed: { providerState: {
      forkSource: { resumeAt: 'assistant-source', sessionId: 'session-source' },
      forkSourceSessionDirectory: source, futureState: { retained: true },
    } },
  });
  try {
    const base = executionRequest();
    const events = await collect(session.execute({ ...base, configuration: {
      ...base.configuration, systemInstructions: { kind: 'main-agent', instructions: 'Keep the Grok replacement.' },
    } }).events);
    expect(native.forkCalls).toEqual([expect.objectContaining({ sourceSessionId: 'session-source', targetPromptIndex: 3 })]);
    expect(native.forkCalls[0]).not.toHaveProperty('_meta');
    expect(native.loadRequests).toEqual([expect.objectContaining({
      _meta: expect.objectContaining({ systemPromptOverride: 'Keep the Grok replacement.' }), sessionId: 'session-forked',
    })]);
    expect(native.newRequests).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'session_state_changed', snapshot: expect.objectContaining({
        providerStateDeletes: ['forkSource', 'forkSourceSessionDirectory'], providerSessionId: 'session-forked', status: 'executing',
      }),
    }));
    expect(events.filter(event => event.type === 'session_state_changed').at(-1)).toMatchObject({
      snapshot: { providerStateDeletes: ['forkSource', 'forkSourceSessionDirectory'], providerSessionId: 'session-forked', status: 'idle' },
    });
    expect(session.getSnapshot().providerStateDeletes).toEqual(['forkSource', 'forkSourceSessionDirectory']);
    expect(session.getSnapshot().providerStateDeletes).not.toContain('futureState');
    expect(session.getSnapshot().providerSessionId).toBe('session-forked');
    expect(session.getSnapshot().providerState).toEqual({ sessionDirectory: child });
    if (!isRewindableExecutionSession(session)) throw new Error('Expected Grok rewind capability.');
    await expect(session.previewRewind('user-target', 'assistant-target')).resolves.toMatchObject({ canRewind: true });
    await expect(session.rewind('user-target', 'assistant-target')).resolves.toMatchObject({ canRewind: true });
    expect(native.rewindCalls).toEqual([
      { force: false, mode: 'conversation_only', sessionId: 'session-forked', targetPromptIndex: 6 },
      { force: true, mode: 'conversation_only', sessionId: 'session-forked', targetPromptIndex: 6 },
    ]);
    native.promptImplementation = async () => { throw new Error('transport closed after fork'); };
    const invalidatedEvents = await collect(session.execute(executionRequest('retry')).events);
    expect(invalidatedEvents.at(-2)).toMatchObject({ snapshot: {
      providerStateDeletes: ['forkSource', 'forkSourceSessionDirectory'], providerSessionId: 'session-forked', status: 'invalidated',
    }, type: 'session_state_changed' });
    expect(native.forkCalls).toHaveLength(1);
  } finally {
    await session.dispose();
    await fs.rm(history.root, { recursive: true, force: true });
  }
});

describe('WSL installations', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let wsl: WSLProcessFixture;
  beforeEach(() => { wsl = new WSLProcessFixture(); vi.stubEnv('SystemRoot', 'C:\\Windows'); });
  afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); });

  async function createWSLHost(): Promise<ProviderHost> {
    const host = await createGrokHost();
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    updateGrokProviderSettings(host.settings, { installationMethod: 'wsl', wslDistroOverride: 'Ubuntu' });
    return host;
  }

  /** wsl.exe runs the Grok CLI as the shared native peer; Linux probes go to the WSL process fixture. */
  function createWSLBackend(host: ProviderHost, peers: GrokNativeProcess[], options: Omit<GrokExecutionBackendOptions, 'nativeFactory'> = {}) {
    const launches: { command: string; args: string[]; windowsVerbatimArguments?: boolean }[] = [];
    vi.mocked(spawn).mockImplementation((command, args = [], spawnOptions = {}) => {
      if (readWSLExec({ args: [...args] }).args[3] !== 'grok') return wsl.spawn(command, args, spawnOptions);
      launches.push({ command, args: [...args], windowsVerbatimArguments: spawnOptions.windowsVerbatimArguments });
      const peer = peers[launches.length - 1];
      if (!peer) throw new Error('Unexpected Grok launch');
      return peer.child;
    });
    const backend = new GrokExecutionBackend(host.getRuntimeHost('grok'), options);
    return {
      launches,
      createSession(config: ProviderSessionConfig) {
        const session = backend.createSession(config);
        sessions.push(session);
        return session;
      },
    };
  }

  it.each(['new', 'load'] as const)('uses Linux cwd and a Windows interop stdio relay for WSL %s', async mode => {
    wsl.environment = { HOME: '/home/test', GROK_HOME: '/home/test/.grok' };
    const native = new GrokNativeProcess();
    native.promptImplementation = async () => {
      for (const update of grokWSLToolUpdates) native.emit(update, 'standard', undefined, mode === 'new' ? 'session-new' : 'session-existing');
      return { stopReason: 'end_turn' };
    };
    const sessionTools = {
      list: vi.fn(async () => ({ sessions: [] })),
      send: vi.fn(async () => ({ sessionId: 'recipient', title: 'Review', provider: 'codex', status: 'queued' as const })),
      read: vi.fn(),
    };
    const backend = createWSLBackend(await createWSLHost(), [native]);
    const session = backend.createSession({
      ...sessionConfig, workingDirectory: 'C:\\vault', sessionTools,
      ...(mode === 'new' ? { resumeSeed: undefined } : {}),
    });
    const events = await collect(session.execute(executionRequest()).events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_started', input: expect.objectContaining({ path: 'C:\\vault\\notes' }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_completed', resultDetails: expect.objectContaining({ diff: expect.objectContaining({ filePath: 'C:\\vault\\note.md' }) }) }));
    const initial = mode === 'new' ? native.newRequests[0] : native.loadRequests[0];
    expect(initial.cwd).toBe('/mnt/c/vault');
    const [server] = initial.mcpServers;
    if (!('command' in server)) throw new Error('Expected a stdio relay server');
    expect(server).toMatchObject({ name: 'claudian_sessions', command: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' });
    expect(server).not.toHaveProperty('url');
    const routeId = server.env?.find(variable => variable.name === 'CLAUDIAN_SESSION_TOOL_ROUTE')?.value;
    expect(routeId).toBeTruthy();
    expect(JSON.stringify(server.args)).not.toContain(routeId);
    expect(JSON.stringify(wsl.requests.map(request => [request.args, request.options.env]))).not.toContain(routeId);
    expect(backend.launches).toHaveLength(1);
    expect(backend.launches[0].windowsVerbatimArguments).toBe(true);
    expect(backend.launches[0].args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/mnt/c/vault']));
    expect(readWSLExec(backend.launches[0]).args.slice(-4)).toEqual(['grok', 'agent', '--no-leader', 'stdio']);
  });

  it('forks inside the distro with Linux cwds for the child and its source', async () => {
    wsl.environment = { HOME: '/home/alice' };
    const native = new GrokNativeProcess();
    // The checkpoint index lives in the Linux store, which the test host cannot read through `\\wsl$`.
    const backend = createWSLBackend(await createWSLHost(), [native], { resolvePromptIndex: async () => 2 });
    const session = backend.createSession({ ...sessionConfig, workingDirectory: 'C:\\vault', resumeSeed: { providerState: {
      forkSource: { resumeAt: 'assistant-source', sessionId: 'session-source' },
      // A source directory whose cwd is not recorded in its path falls back to the launch cwd.
      forkSourceSessionDirectory: '\\\\wsl$\\Ubuntu\\home\\alice\\.grok\\sessions\\unrecorded\\session-source',
    } } });
    await collect(session.execute(executionRequest()).events);
    expect(native.forkCalls).toEqual([expect.objectContaining({
      newCwd: '/mnt/c/vault', sourceCwd: '/mnt/c/vault', sourceSessionId: 'session-source', targetPromptIndex: 2,
    })]);
    expect(native.loadRequests).toEqual([expect.objectContaining({ cwd: '/mnt/c/vault', sessionId: 'session-forked' })]);
  });

  it('reports rewind files and conflicts as host paths', async () => {
    wsl.environment = { HOME: '/home/alice' };
    const native = new GrokNativeProcess();
    native.rewindImplementation = async params => ({
      success: true, targetPromptIndex: params.targetPromptIndex, mode: params.mode, error: null,
      // Absolute Linux paths are the mapping premise (no native capture yet); relative paths stay literal.
      cleanFiles: ['/mnt/c/vault/clean.md', 'relative.md'], revertedFiles: ['/home/alice/notes/reverted.md'],
      conflicts: [{ conflictType: 'modified', path: '/mnt/c/vault/conflict.md' }],
    });
    const backend = createWSLBackend(await createWSLHost(), [native], { resolvePromptIndex: async () => 4 });
    const session = backend.createSession({ ...sessionConfig, workingDirectory: 'C:\\vault', resumeSeed: {
      providerSessionId: 'session-existing',
      providerState: { sessionDirectory: '\\\\wsl$\\Ubuntu\\home\\alice\\.grok\\sessions\\%2Fmnt%2Fc%2Fvault\\session-existing' },
    } });
    if (!isRewindableExecutionSession(session)) throw new Error('Expected Grok rewind capability.');
    await expect(session.previewRewind('user-target', 'assistant-target')).resolves.toEqual({
      canRewind: true,
      filesChanged: ['C:\\vault\\clean.md', 'relative.md', '\\\\wsl$\\Ubuntu\\home\\alice\\notes\\reverted.md'],
      conflicts: [{ conflictType: 'modified', path: 'C:\\vault\\conflict.md' }],
    });
    expect(native.rewindCalls).toEqual([{ force: false, mode: 'conversation_only', sessionId: 'session-existing', targetPromptIndex: 4 }]);
  });

  it.each(['execute', 'previewRewind', 'rewind'] as const)('retires a changed WSL store before %s and resumes within the same store', async operation => {
    const host = await createWSLHost();
    const natives = [new GrokNativeProcess(), new GrokNativeProcess(), new GrokNativeProcess()];
    // Rewind indexes come from the Linux store, which the test host cannot read through `\\wsl$`.
    const options = { resolvePromptIndex: async () => 0 };
    const config = { ...sessionConfig, workingDirectory: 'C:\\vault', resumeSeed: undefined };
    wsl.environment = { HOME: '/home/alice' };
    const first = createWSLBackend(host, [natives[0]], options).createSession(config);
    await collect(first.execute(executionRequest()).events);
    const original = first.getSnapshot();
    await first.dispose();
    wsl.environment = { HOME: '/home/bob' };
    // The directory Windows resolved through `\\wsl$` on the run that created the checkpoint.
    const sessionDirectory = '\\\\wsl$\\Ubuntu\\home\\alice\\.grok\\sessions\\%2Fmnt%2Fc%2Fvault\\session-new';
    const second = createWSLBackend(host, [natives[1]], options).createSession({ ...config,
      resumeSeed: { providerSessionId: original.providerSessionId, providerState: { ...original.providerState, sessionDirectory } },
    });
    if (!isRewindableExecutionSession(second)) throw new Error('Expected Grok rewind capability.');
    const preview = operation === 'execute' ? undefined : await second[operation]('user-target', 'assistant-target');
    expect(preview?.canRewind).toBe(operation === 'execute' ? undefined : false);
    expect(natives[1].newRequests).toEqual([]);
    expect(natives[1].loadRequests).toEqual([]);
    expect(natives[1].rewindCalls).toEqual([]);
    expect(second.getSnapshot().providerSessionId).toBe(operation === 'execute' ? original.providerSessionId : undefined);
    expect(second.getSnapshot().providerState?.historySessionId).toBe(operation === 'execute' ? undefined : original.providerSessionId);
    await collect(second.execute(executionRequest()).events);
    expect(natives[1].loadRequests).toEqual([]);
    expect(natives[1].newRequests).toHaveLength(1);
    const changed = second.getSnapshot();
    expect(changed.providerState?.sessionStoreKey).not.toBe(original.providerState?.sessionStoreKey);
    await second.dispose();
    const third = createWSLBackend(host, [natives[2]], options).createSession({ ...config,
      resumeSeed: { providerSessionId: changed.providerSessionId, providerState: changed.providerState },
    });
    await collect(third.execute(executionRequest()).events);
    expect(natives[2].newRequests).toEqual([]);
    expect(natives[2].loadRequests).toHaveLength(1);
  });
});
