import { capturedSelections } from '@test/helpers/capturedSelections';
import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { CodexRuntimeHarness } from '@test/helpers/providers/codex/CodexRuntimeHarness';
import { parseCodexSessionContent } from '@test/helpers/providers/codex/parseCodexSessionContent';
import { testDate } from '@test/helpers/testClock';

import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderInteractionPort, ProviderSessionConfig } from '@/core/execution';
import { isSteerableExecutionSession } from '@/core/execution';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { decodeCodexConfig } from '@/providers/codex/config';
import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';
import { buildCodexLaunchSpec } from '@/providers/codex/runtime/CodexLaunchSpecBuilder';
import { CodexRPCTransport } from '@/providers/codex/runtime/CodexRPCTransport';

const mockNative = new CodexRuntimeHarness();
vi.mock('@/providers/codex/runtime/CodexAppServerProcess', () => ({
  CodexAppServerProcess: vi.fn().mockImplementation(function () { return mockNative.createProcess(); }),
}));
vi.mock('@/providers/codex/runtime/codexAppServerSupport', async () => ({
  ...(await vi.importActual<typeof import('@/providers/codex/runtime/codexAppServerSupport')>('@/providers/codex/runtime/codexAppServerSupport')),
  resolveCodexAppServerLaunchSpec: async (host: ProviderRuntimeHost) => buildCodexLaunchSpec({
    codexSettings: decodeCodexConfig(host.config), resolvedCliCommand: 'codex', env: {}, hostVaultPath: '/vault',
    executionTarget: { method: 'host-native', platformFamily: 'unix', platformOs: 'linux' },
  }),
}));

const request: ProviderExecutionRequest = {
  input: [{ type: 'text', text: 'hello' }],
  configuration: {
    model: TEST_CODEX_MODEL, reasoning: 'high', serviceTier: 'priority', permissionMode: 'yolo',
    systemInstructions: { kind: 'explicit', instructions: 'Be concise.' },
  },
  toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal,
};
let settings: Awaited<ReturnType<typeof createProviderHostFixture>>['settings'];
let runtime: CodexAppServerRuntime;
let backend: CodexExecutionBackend;
const sessions: ReturnType<CodexExecutionBackend['createSession']>[] = [];
function createSession(overrides: Partial<ProviderSessionConfig> = {}) {
  const session = backend.createSession({
    lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: '/vault',
    interactionPort: { requestApproval: vi.fn(), askUserQuestion: vi.fn(), dismissInteraction: vi.fn() }, ...overrides,
  });
  sessions.push(session);
  return session;
}
async function collect(events: AsyncIterable<ProviderExecutionEvent>) {
  const result: ProviderExecutionEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function complete(threadId = 'thread-1') {
  const process = mockNative.processes[0];
  process.notify('turn/completed', { threadId, turn: { ...process.turns.get(threadId), status: 'completed' } });
}
function serverRequest(id: string, method: string, params: Record<string, unknown>) {
  return mockNative.processes[0].requestFromServer(id, method, params);
}

beforeEach(async () => {
  mockNative.reset();
  mockNative.autoReconcile = true;
  const fixture = await createProviderHostFixture({ vault: sharedVault, settings: { providerConfigs: { codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG, responseStyle: 'pragmatic' } } } });
  settings = fixture.settings;
  const host = fixture.host.getRuntimeHost('codex');
  runtime = new CodexAppServerRuntime(host, () => undefined);
  backend = new CodexExecutionBackend(host, () => runtime);
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  await runtime.dispose();
  vi.restoreAllMocks();
});

it('preserves a pre-spawn failure in the execution error and cleans up exactly once', async () => {
  const process = mockNative.createProcess();
  vi.spyOn(mockNative, 'createProcess').mockReturnValueOnce(process);
  vi.spyOn(process, 'start').mockImplementationOnce(() => {
    throw new Error('Failed before Codex process spawned');
  });
  const shutdown = vi.spyOn(process, 'shutdown');
  const disposeTransport = vi.spyOn(CodexRPCTransport.prototype, 'dispose');
  const session = createSession();

  const events = await collect(session.execute(request).events);

  expect(events.at(-1)).toMatchObject({
    type: 'execution_error', message: expect.stringContaining('Failed before Codex process spawned'),
  });
  expect(process.isAlive()).toBe(false);
  expect(process.requests).toEqual([]);
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(disposeTransport).toHaveBeenCalledTimes(1);
  await session.dispose();
  await runtime.dispose();
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(disposeTransport).toHaveBeenCalledTimes(1);
});

it.each(['priority', 'default'])('correlates a persistent turn from native startup through output with explicit %s tier', async serviceTier => {
  settings.providerConfigs.codex!.discoveredModels = TEST_CODEX_CATALOG.map(model => ({ ...model, defaultServiceTier: 'priority' }));
  const session = createSession();
  const run = session.execute({ ...request, configuration: { ...request.configuration, serviceTier } });
  const output = collect(run.events);
  const process = await mockNative.waitForRequest('turn/start');
  expect(process.notifications).toContainEqual({ jsonrpc: '2.0', method: 'initialized' });
  const start = process.requests.find(rpc => rpc.method === 'thread/start')!.params;
  expect(start).toMatchObject({
    cwd: '/vault', experimentalRawEvents: true, persistExtendedHistory: true,
    dynamicTools: [expect.objectContaining({ namespace: 'codex_app', name: 'load_workspace_dependencies' })],
  });
  expect(start.ephemeral).not.toBe(true);
  expect(process.requests.find(rpc => rpc.method === 'turn/start')!.params).toMatchObject({
    model: TEST_CODEX_MODEL, effort: 'high', serviceTier, personality: 'pragmatic',
  });
  const scope = { threadId: 'thread-1', turnId: 'turn-thread-1' };
  process.notify('item/started', { ...scope, item: { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'hello' }] } });
  process.notify('item/agentMessage/delta', { ...scope, itemId: 'answer', delta: 'Hello' });
  process.notify('item/agentMessage/delta', { ...scope, itemId: 'answer', delta: ' world' });
  complete();
  const events = await output;
  expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
    'session_state_changed', 'turn_started', 'user_message_started', 'text_delta', 'turn_completed',
  ]));
  expect(events.filter(event => event.type === 'text_delta').map(event => event.text)).toEqual(['Hello', ' world']);
  expect(events.at(-1)).toMatchObject({ type: 'turn_completed', nativeAssistantId: 'turn-thread-1', nativeCheckpointId: 'turn-thread-1' });
  expect(events.find(event => event.type === 'turn_started')).toMatchObject({
    accepted: true, nativeTurnId: 'turn-thread-1', scope: { kind: 'requested', executionId: run.executionId, turnId: run.turnId },
  });
  expect(session.getSnapshot()).toMatchObject({ providerSessionId: 'thread-1', status: 'idle', revision: expect.any(Number) });
});

it('resumes a fixed seed once and applies response-style changes on subsequent turns', async () => {
  const session = createSession({ resumeSeed: { providerSessionId: 'existing', providerState: { threadId: 'existing', sessionFilePath: '/tmp/existing.jsonl' } } });
  for (const [index, responseStyle] of ['pragmatic', 'none', 'friendly'].entries()) {
    settings.providerConfigs.codex!.responseStyle = responseStyle;
    const output = collect(session.execute(request).events);
    await mockNative.waitForRequest('turn/start', 0, index + 1);
    complete('existing');
    await output;
  }
  const process = mockNative.processes[0];
  expect(mockNative.processes).toHaveLength(1);
  expect(process.requests.filter(rpc => rpc.method === 'thread/resume')).toHaveLength(1);
  expect(process.requests.filter(rpc => rpc.method === 'turn/start').map(rpc => rpc.params.personality)).toEqual(['pragmatic', 'none', 'friendly']);
});

it('replays retired history once and restores only visible user input from the native rollout', async () => {
  const previousSegments = [{ threadId: 'invalidated', sessionFilePath: '/home/test/.codex/sessions/invalidated.jsonl' }];
  const session = createSession({ resumeSeed: { providerState: { nativeConversationContextEstablished: false, previousSegments } } });
  const conversationHistory = [
    { id: 'u', role: 'user' as const, content: 'prior question', timestamp: testDate().getTime() },
    { id: 'a', role: 'assistant' as const, content: 'prior answer', timestamp: testDate({ seconds: 1 }).getTime() },
  ];
  const first = collect(session.execute({ ...request, conversationHistory }).events);
  const process = await mockNative.waitForRequest('turn/start');
  complete();
  expect(await first).toContainEqual(expect.objectContaining({ type: 'session_state_changed', snapshot: expect.objectContaining({ status: 'executing', providerSessionId: 'thread-1' }) }));
  const second = collect(session.execute({ ...request, conversationHistory, input: [{ type: 'text', text: 'Follow up' }] }).events);
  await mockNative.waitForRequest('turn/start', 0, 2);
  complete();
  await second;
  const inputs = process.requests.filter(rpc => rpc.method === 'turn/start').map(rpc => rpc.params.input);
  expect(JSON.stringify(inputs[0])).toContain('prior question');
  expect(JSON.stringify(inputs[0])).toContain('prior answer');
  expect(JSON.stringify(inputs[1])).not.toContain('prior question');
  expect(JSON.stringify(inputs[1])).toContain('Follow up');
  const replayed = inputs[0].find((item: { type: string }) => item.type === 'text').text;
  const rollout = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-thread-1' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: replayed }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'replayed answer' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-thread-1' } },
  ].map(record => JSON.stringify(record)).join('\n');
  expect(parseCodexSessionContent(rollout).map(message => message.content)).toEqual(['hello', 'replayed answer']);
  expect(session.getSnapshot().providerState).toMatchObject({ threadId: 'thread-1', nativeConversationContextEstablished: true, previousSegments });
});

it.each(['cancel', 'dispose'] as const)('rejects concurrent runs and %s interrupts only its turn without shutting down the server', async action => {
  const session = createSession();
  const run = session.execute(request);
  expect(() => session.execute(request)).toThrow(/active/i);
  const output = collect(run.events);
  const process = await mockNative.waitForRequest('turn/start');
  if (action === 'cancel') run.cancel();
  else await Promise.all([session.dispose(), session.dispose()]);
  expect((await output).at(-1)?.type).toBe('cancelled');
  expect(process.requests.filter(rpc => rpc.method === 'turn/interrupt').map(rpc => rpc.params)).toEqual([{ threadId: 'thread-1', turnId: 'turn-thread-1' }]);
  await session.dispose();
  expect(process.requests.filter(rpc => rpc.method === 'thread/unsubscribe')).toHaveLength(1);
  expect(process.isAlive()).toBe(true);
  expect(session.getStatus()).toBe('disposed');
  expect(() => session.execute(request)).toThrow(/disposed/i);
});

it('routes approvals, questions and MCP confirmations with local identities and native replies', async () => {
  const interactionPort = {
    requestApproval: vi.fn<ProviderInteractionPort['requestApproval']>(async query => ({ interactionId: query.interactionId, decision: 'allow' as const })),
    askUserQuestion: vi.fn<ProviderInteractionPort['askUserQuestion']>(async query => {
      const confirmation = Array.isArray(query.input.questions)
        && query.input.questions.some((question: unknown) => typeof question === 'object' && question !== null && 'id' in question && question.id === 'mcp-elicitation-confirmation');
      const answers: Record<string, string> = confirmation ? { 'mcp-elicitation-confirmation': 'accept' } : { choice: 'yes' };
      return { interactionId: query.interactionId, answers };
    }),
    dismissInteraction: vi.fn<ProviderInteractionPort['dismissInteraction']>(),
  };
  const session = createSession({ interactionPort });
  const output = collect(session.execute(request).events);
  await mockNative.waitForRequest('turn/start');
  const scope = { threadId: 'thread-1', turnId: 'turn-thread-1' };
  await serverRequest('approval', 'item/commandExecution/requestApproval', { ...scope, itemId: 'command', command: 'pwd', cwd: '/vault' });
  await serverRequest('question', 'item/tool/requestUserInput', { ...scope, itemId: 'question', questions: [{ id: 'choice', header: 'Choice', question: 'Continue?', options: null, isOther: false, isSecret: false }] });
  expect(await serverRequest('mcp', 'mcpServer/elicitation/request', { ...scope, serverName: 'cua_repl', mode: 'form', message: 'Allow Computer Use to use Obsidian?', requestedSchema: { type: 'object', properties: {} } })).toEqual({ action: 'accept', content: {} });
  const approval = interactionPort.requestApproval.mock.calls[0][0];
  const question = interactionPort.askUserQuestion.mock.calls[0][0];
  expect(approval).toMatchObject({ interactionId: expect.any(String), sessionInstanceId: session.sessionInstanceId, kind: 'approval', nativeContext: { requestId: 'approval' } });
  expect(question).toMatchObject({ interactionId: expect.any(String), sessionInstanceId: session.sessionInstanceId, kind: 'question', nativeContext: { requestId: 'question' } });
  expect(question.interactionId).not.toBe(approval.interactionId);
  complete();
  expect((await output).at(-1)?.type).toBe('turn_completed');
});

it('requires a new ephemeral session after its native process exits', async () => {
  const session = createSession({ lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported' });
  const first = collect(session.execute(request).events);
  const process = await mockNative.waitForRequest('turn/start');
  complete();
  await first;
  expect(process.requests.find(rpc => rpc.method === 'thread/start')!.params).toMatchObject({ ephemeral: true, persistExtendedHistory: false });
  await process.shutdown();
  const events = await collect(session.execute({ ...request, conversationHistory: [
    { id: 'u', role: 'user', content: 'Remember A', timestamp: testDate().getTime(), images: [{ id: 'image', name: 'image.png', data: 'aW1hZ2U=', mediaType: 'image/png', source: 'paste', size: 5 }] },
    { id: 'a', role: 'assistant', content: 'Noted A', timestamp: testDate({ seconds: 1 }).getTime() },
  ], input: [{ type: 'text', text: 'Continue with B' }] }).events);
  expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: expect.stringContaining('cannot be restored') });
  expect(mockNative.processes.flatMap(process => process.requests).filter(rpc => rpc.method === 'turn/start')).toHaveLength(1);
});

it.each(['/compact', ' \t/CoMpAcT  '])('binds compact %j to its started notification, ignoring attached context and images', async text => {
  mockNative.requestOverride = (process, rpc) => {
    if (rpc.method !== 'thread/compact/start') return false;
    process.respond(rpc.id, {});
    process.notify('turn/started', { threadId: 'existing', turn: { id: 'compact-turn', status: 'inProgress', items: [] } });
    process.notify('turn/completed', { threadId: 'existing', turn: { id: 'compact-turn', status: 'completed', items: [] } });
    return true;
  };
  const session = createSession({ resumeSeed: { providerSessionId: 'existing', providerState: { threadId: 'existing', nativeConversationContextEstablished: true } } });
  const events = await collect(session.execute({ ...request, context: capturedSelections, input: [
    { type: 'text', text }, { type: 'image', image: { id: 'image', name: 'image.png', data: 'aW1hZ2U=', mediaType: 'image/png', size: 5, source: 'paste' } },
  ] }).events);
  const process = mockNative.processes[0];
  expect(process.requests.filter(rpc => rpc.method === 'thread/compact/start').map(rpc => rpc.params)).toEqual([{ threadId: 'existing' }]);
  expect(process.requests.filter(rpc => rpc.method === 'turn/start')).toEqual([]);
  expect(events).toContainEqual(expect.objectContaining({ type: 'turn_started', accepted: true, nativeTurnId: 'compact-turn' }));
});

it('cancels execution when its event consumer closes before native acknowledgement', async () => {
  mockNative.requestOverride = (_process, rpc) => rpc.method === 'turn/start';
  const session = createSession();
  const run = session.execute(request);
  const process = await mockNative.waitForRequest('turn/start');
  expect(session.getSnapshot().status).toBe('executing');
  await run.events[Symbol.asyncIterator]().return?.();
  expect(session.getSnapshot().status).toBe('idle');
  process.respond(process.requests.find(rpc => rpc.method === 'turn/start')!.id, { turn: { id: 'late-turn', status: 'inProgress', items: [] } });
});

it('preserves native tool IDs while steering and answering an unavailable workspace tool', async () => {
  mockNative.requestOverride = (process, rpc) => {
    if (rpc.method !== 'turn/steer') return false;
    process.respond(rpc.id, { turnId: 'turn-thread-1' });
    return true;
  };
  const session = createSession();
  const run = session.execute(request);
  const output = collect(run.events);
  const process = await mockNative.waitForRequest('turn/start');
  const scope = { threadId: 'thread-1', turnId: 'turn-thread-1' };
  process.notify('item/started', { ...scope, item: { type: 'commandExecution', id: 'tool-native', command: 'pwd', cwd: '/vault', status: 'inProgress' } });
  expect(await serverRequest('dynamic', 'item/tool/call', { ...scope, callId: 'dynamic-call', namespace: 'codex_app', tool: 'load_workspace_dependencies', arguments: {} })).toMatchObject({ success: false, contentItems: [expect.objectContaining({ type: 'inputText', text: expect.stringContaining('unavailable') })] });
  if (!isSteerableExecutionSession(session)) throw new Error('Codex must support steering');
  await expect(session.steer({ ...request, input: [{ type: 'text', text: 'steer' }] })).resolves.toBe(true);
  run.cancel();
  expect(await output).toContainEqual(expect.objectContaining({ type: 'tool_started', toolCallId: 'tool-native', toolScope: { kind: 'main' } }));
  expect(process.requests.find(rpc => rpc.method === 'turn/steer')!.params).toMatchObject({ threadId: 'thread-1', expectedTurnId: 'turn-thread-1' });
});

let sharedVault: DesktopVault;
beforeAll(async () => { sharedVault = await DesktopVault.create(); });
afterAll(async () => { await sharedVault.dispose(); });
