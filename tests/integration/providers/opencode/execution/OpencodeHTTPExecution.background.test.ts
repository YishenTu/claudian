import { writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { createForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';
import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';
import { createFixture, fixture, request } from '@test/helpers/providers/opencode/OpencodeHTTPExecutionFixture';

import { type ProviderExecutionEvent, ProviderExecutionLifecycleRegistry, type ProviderSessionEvent } from '@/core/execution';
import { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { providerOutputEventToStreamChunk } from '@/features/chat/rendering/providerOutputChunks';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';

it('delivers child completion and automatic parent replies after the requested turn', async () => {
  const f = await createFixture();
  const events: ProviderSessionEvent[] = [];
  let completed!: () => void;
  const background = new Promise<void>(resolve => { completed = resolve; });
  f.session.onEvent(event => { events.push(event); if (event.type === 'background_turn_completed') completed(); });
  try {
    const requested = [];
    for await (const event of f.session.execute(request('background')).events) requested.push(event);
    expect(requested.at(-1)?.type).toBe('turn_completed');
    expect(requested).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_completed', content: 'Child read result', toolScope: { kind: 'subagent', subagentId: 'tool_child' } })]));
    const childCompletion = requested.find(event => event.type === 'tool_completed' && event.content === 'Child read result')!;
    expect(providerOutputEventToStreamChunk(childCompletion)).toMatchObject({
      type: 'subagent_tool_result', subagentId: 'tool_child',
      providerPayload: { rawOutput: { content: [{ type: 'text', text: 'Child read result' }] } },
    });
    await background;
    // Child activity reaches the parent card as display-only session progress.
    expect(events.flatMap(event => event.type === 'subagent_progress' ? [event.progress] : [])).toEqual([
      expect.objectContaining({ toolCallId: 'tool_child', toolUses: 1, lastToolName: 'Read' }),
      expect.objectContaining({ toolCallId: 'tool_child', toolUses: 1, lastToolName: 'Read', totalTokens: 1500, durationMs: expect.any(Number) }),
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'async_subagent_completed', subagentId: 'ses_child', result: 'Child result', status: 'completed' }),
      expect.objectContaining({ type: 'text_delta', text: 'Automatic reply', scope: expect.objectContaining({ kind: 'background' }) }),
    ]));
  } finally { await f.dispose(); }
});

it.each(['background-approval', 'background-nested', 'mcp-form-late'])('keeps %s interactions current and protects execution from cooling after the parent finishes', async text => {
  const env = await createForkTestEnvironment();
  const cliPath = path.join(env.root, 'opencode.cjs');
  writeFileSync(cliPath, fixture, { mode: 0o700 });
  env.host.getResolvedProviderCliPath = async () => cliPath;
  env.host.mutateSettings = async mutate => { await mutate(env.host.settings); };
  env.host.mutateSettingsConditionally = async mutate => { await mutate(env.host.settings); };
  env.host.notifyProviderChatOptionsChanged = () => undefined;
  env.host.settings.providerConfigs.opencode = { enabled: true, visibleModels: ['deepseek/chat'], discoveredModels: [{ rawId: 'deepseek/chat', label: 'DeepSeek' }] };
  const serverService = new OpencodeServerService();
  const backend = new OpencodeExecutionBackend(runtimeHostFor(env.host, 'opencode'), { serverService });
  const conversation = await env.repository.create({ providerId: 'opencode' });
  let release!: () => void, childAsked!: () => void, replied!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const asked = new Promise<void>(resolve => { childAsked = resolve; });
  const automaticReply = new Promise<void>(resolve => { replied = resolve; });
  let idle!: () => void;
  const settled = new Promise<void>(resolve => { idle = resolve; });
  const interactions: string[] = [];
  const events: ProviderSessionEvent[] = [];
  const coordinator = new ChatExecutionCoordinator({
    lifecycleRegistry: new ProviderExecutionLifecycleRegistry(), resolveBackend: () => backend,
    persistence: env.repository, workingDirectory: env.root, createId: () => 'execution-child',
    resolveMissingProviderSession: async () => 'preserved',
    interactionPort: {
      requestApproval: async request => {
        if (request.description?.includes('echo child')) { interactions.push('approval'); await gate; }
        return { interactionId: request.interactionId, decision: 'allow' };
      },
      askUserQuestion: async request => {
        if (Array.isArray(request.input.questions) && ['Child color', 'probe is requesting input'].includes(request.input.questions[0]?.header)) { interactions.push('question'); childAsked(); await gate; }
        return { interactionId: request.interactionId, answers: { q0: 'blue' } };
      },
      dismissInteraction() {},
    },
    onBackgroundWorkChanged: working => {
      if (!working && events.some(event => event.type === 'text_delta' && event.text === 'Automatic reply')) idle();
    },
    onSessionEvent: event => {
      events.push(event);
      if (event.type === 'text_delta' && event.text === 'Automatic reply') replied();
    },
  });
  try {
    await coordinator.bindConversation({ conversationId: conversation.id, providerId: 'opencode' });
    const result = await coordinator.execute({
      submissionId: 'user-child', timestamp: 1,
      rawDisplayText: text, canonicalText: text, images: [],
      configuration: request().configuration, toolPolicy: { kind: 'provider-default' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    if (text === 'mcp-form-late') await asked;
    expect(coordinator.hasBackgroundWork).toBe(true);
    await asked;
    expect(interactions).toEqual(text === 'mcp-form-late' ? ['question'] : ['approval', 'question']);
    release();
    await automaticReply;
    await settled;
    const completions = events.filter(event => event.type === 'async_subagent_completed');
    const expectedChildren = text === 'mcp-form-late' ? [] : text === 'background-nested' ? ['ses_child', 'ses_grand'] : ['ses_child'];
    expect(completions.map(event => event.subagentId)).toEqual(expectedChildren);
    expect(completions.filter(event => event.subagentId === 'ses_child').map(event => event.result)).toEqual(text === 'mcp-form-late' ? [] : ['Child result']);
    expect(new Set(completions.map(event => event.originatingTurnId)).size).toBe(text === 'mcp-form-late' ? 0 : 1);
    expect(coordinator.hasBackgroundWork).toBe(false);
  } finally { release(); await coordinator.dispose(); await serverService.dispose(); await env.dispose(); }
});

it('ends a stopped automatic reply as interrupted, as its native idle outcome replays it', async () => {
  const f = await createFixture();
  const events: ProviderSessionEvent[] = [];
  f.session.onEvent(event => events.push(event));
  const waitForCondition = async (condition: () => boolean) => {
    for (const deadline = Date.now() + 3000; !condition(); await new Promise(resolve => setTimeout(resolve, 10))) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for the automatic reply');
    }
  };
  try {
    for await (const event of f.session.execute(request('background-stop')).events) void event;
    await waitForCondition(() => events.some(event => event.type === 'text_delta' && event.text === 'Automatic reply'));
    f.session.cancel();
    const turnOf = (event: ProviderSessionEvent | undefined) => event?.scope.kind === 'background' ? event.scope.turnId : undefined;
    const reply = turnOf(events.find(event => event.type === 'text_delta' && event.text === 'Automatic reply'));
    const completion = () => events.find(event => event.type === 'background_turn_completed' && turnOf(event) === reply);
    await waitForCondition(() => completion() !== undefined);
    expect(completion()).toMatchObject({ reason: 'interrupted' });
  } finally { await f.dispose(); }
});

it('cancels a background child waiting for approval and can continue the native parent', async () => {
  let childAsked!: () => void;
  const asked = new Promise<void>(resolve => { childAsked = resolve; });
  let dismissed!: () => void;
  const dismissal = new Promise<void>(resolve => { dismissed = resolve; });
  let approvals = 0;
  const f = await createFixture(false, async signal => {
    if (++approvals !== 2) return;
    childAsked();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { dismissed(); resolve(); }, { once: true }));
  });
  const events: ProviderSessionEvent[] = [];
  f.session.onEvent(event => events.push(event));
  try {
    const parent: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('background-approval')).events) parent.push(event);
    expect(parent.at(-1)?.type).toBe('turn_completed');
    await asked;
    f.session.cancel();
    expect(f.session.getStatus()).toBe('invalidated');
    await dismissal;
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'background_turn_completed', reason: 'provider-ended' })]));
    const continued: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('continue')).events) continued.push(event);
    expect(continued.at(-1)?.type).toBe('turn_completed');
    expect(f.session.getSnapshot().providerSessionId).toBe('ses_test');
  } finally { await f.dispose(); }
});

it.each(['configuration', 'prompt'])('keeps an earlier child in its own scope during a later turn %s', async stage => {
  const f = await createFixture(false, undefined, `LATE_CHILD_STAGE=${stage}`);
  const background: ProviderSessionEvent[] = [];
  const foreground: ProviderExecutionEvent[] = [];
  let completed!: () => void;
  const childCompleted = new Promise<void>(resolve => { completed = resolve; });
  f.session.onEvent(event => {
    background.push(event);
    if (event.type === 'async_subagent_completed') completed();
  });
  try {
    for await (const event of f.session.execute(request('background-overlap')).events) {
      if (event.type === 'execution_error') throw new Error(event.message);
    }
    const run = f.session.execute(request('cancel'));
    const consume = (async () => {
      for await (const event of run.events) foreground.push(event);
    })();
    await childCompleted;
    run.cancel();
    await consume;
    expect(background).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'tool_completed', content: 'Late child result',
      scope: expect.objectContaining({ kind: 'background' }),
    })]));
    expect(foreground.filter(event => event.type === 'tool_completed' && event.content === 'Late child result')).toEqual([]);
  } finally { await f.dispose(); }
});
