import { writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { createForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';
import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';
import { createFixture, fixture, releaseSteeringEventsOnAdmission, request } from '@test/helpers/providers/opencode/OpencodeHTTPExecutionFixture';

import { isSteerableExecutionSession, type ProviderExecutionEvent, ProviderExecutionLifecycleRegistry, type ProviderSessionEvent } from '@/core/execution';
import type { ChatMessage } from '@/core/types';
import { ChatExecutionCoordinator, type ChatSteerOutcome } from '@/features/chat/execution/ChatExecutionCoordinator';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';

describe('native steering', () => {
  beforeEach(releaseSteeringEventsOnAdmission);

  it.each(['/compact', '/COMPACT'])('preserves captures and images when steering literal %j text', async text => {
    const f = await createFixture(false, undefined, 'ECHO_PROMPT=1');
    try {
      const events: ProviderExecutionEvent[] = [];
      let admission: Promise<boolean> | undefined;
      for await (const event of f.session.execute(request('steer')).events) {
        events.push(event);
        if (event.type === 'text_delta' && event.text === 'Working') {
          if (!isSteerableExecutionSession(f.session)) throw new Error('Missing steering');
          admission = f.session.steer({
            ...request(text),
            input: [{ type: 'text', text }, { type: 'image', image: {
              id: 'capture', name: 'capture.png', data: 'aW1hZ2U=',
              mediaType: 'image/png', size: 5, source: 'paste',
            } }],
            context: { selections: [{ kind: 'editor', selection: { notePath: 'note.md', mode: 'selection', selectedText: 'captured note' } }] },
          });
        }
      }
      expect(await admission).toBe(true);
      expect(events.at(-1)?.type).toBe('turn_completed');
      const echoed = events.flatMap(event => event.type === 'text_delta' && event.text !== 'Working' ? [event.text] : []).join('');
      expect(JSON.parse(echoed)).toEqual({
        id: expect.any(String), delivery: 'steer',
        text: `${text}\n\n<editor_selection path="note.md">\n<![CDATA[captured note]]>\n</editor_selection>`,
        files: [{ uri: 'data:image/png;base64,aW1hZ2U=' }],
      });
      expect(events.some(event => event.type === 'context_compacted')).toBe(false);
    } finally { await f.dispose(); }
  });

  it.each([
    ['Now apply /writing', { skills: [{ id: 'writing', mention: { start: 10, end: 18, text: '/writing' } }] }],
    ['Explain this example:\n```\n/writing\n```', {}],
  ])('attaches only prose skills to steered input: %s', async (text, attachments) => {
    const f = await createFixture(false, undefined, 'ECHO_PROMPT=1');
    try {
      const events: ProviderExecutionEvent[] = [];
      let admission: Promise<boolean> | undefined;
      for await (const event of f.session.execute(request('steer')).events) {
        events.push(event);
        if (event.type === 'text_delta' && event.text === 'Working') admission = steer(f, text);
      }
      expect(await admission).toBe(true);
      const echoed = events.flatMap(event => event.type === 'text_delta' && event.text !== 'Working' ? [event.text] : []).join('');
      expect(JSON.parse(echoed)).toEqual({
        id: expect.any(String), delivery: 'steer', text,
        ...attachments,
      });
    } finally { await f.dispose(); }
  });

  function steer(f: Awaited<ReturnType<typeof createFixture>>, text: string): Promise<boolean> {
    if (!isSteerableExecutionSession(f.session)) throw new Error('Missing steering');
    return f.session.steer(request(text));
  }

  async function steerDuring(f: Awaited<ReturnType<typeof createFixture>>, text: string) {
    const events: ProviderExecutionEvent[] = [];
    const background: ProviderSessionEvent[] = [];
    f.session.onEvent(event => background.push(event));
    const run = f.session.execute(request(text));
    let steered: Promise<boolean> | undefined;
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'text_delta' && event.text === 'Working' && !steered) {
        steered = steer(f, 'Also check tests');
        if (text === 'steer-cancel') run.cancel();
      }
    }
    return { events, background, accepted: await steered };
  }

  it.each(['steer', 'steer-late'])('keeps a %s delivery inside the requested run until the native inbox delivers it', async text => {
    const f = await createFixture();
    try {
      const { events, background, accepted } = await steerDuring(f, text);
      expect(accepted).toBe(true);
      // Consumers bind the first user boundary to the submitted prompt, never to a steer.
      const boundaries = events.filter(event => event.type === 'user_message_started');
      expect(boundaries).toEqual([
        expect.objectContaining({ nativeUserMessageId: expect.stringMatching(/^msg_/) }),
        expect.objectContaining({ content: 'Also check tests', nativeUserMessageId: expect.stringMatching(/^msg_/) }),
      ]);
      expect(boundaries[0]).not.toHaveProperty('content');
      expect(boundaries[0].nativeUserMessageId).not.toBe(boundaries[1].nativeUserMessageId);
      const boundary = events.indexOf(boundaries[1]);
      expect(events.slice(boundary + 1).map(event => event.type)).toEqual(['assistant_message_started', 'text_delta', 'session_state_changed', 'turn_completed']);
      expect(events.filter(event => event.type === 'text_delta').map(event => event.text)).toEqual(['Working', 'Saw Also check tests']);
      expect(background.filter(event => event.type === 'background_turn_started')).toEqual([]);
    } finally { await f.dispose(); }
  });

  it('recalls an undelivered steer on cancel so it cannot leak into the next turn', async () => {
    const f = await createFixture();
    try {
      const { events, accepted } = await steerDuring(f, 'steer-cancel');
      expect(events.at(-1)?.type).toBe('cancelled');
      expect(accepted).toBe(false);
      const continued: ProviderExecutionEvent[] = [];
      for await (const event of f.session.execute(request('continue')).events) continued.push(event);
      expect(continued.at(-1)?.type).toBe('turn_completed');
      expect(continued.filter(event => event.type === 'text_delta').map(event => event.text).join('')).toBe('Finished review');
    } finally { await f.dispose(); }
  });

  it('reports a natively refused steer as definitely unsent and lets the run finish', async () => {
    const f = await createFixture(false, undefined, 'STEER_ADMISSION=reject');
    try {
      expect(await steer(f, 'Before any run')).toBe(false);
      const { events, accepted } = await steerDuring(f, 'steer');
      expect(accepted).toBe(false);
      expect(events.filter(event => event.type === 'user_message_started' && event.content)).toEqual([]);
      expect(events.at(-1)?.type).toBe('turn_completed');
    } finally { await f.dispose(); }
  });

  it.each(['steer', 'steer-late'])('keeps the submitted pair bound to the prompt across a %s delivery', async text => {
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
    const events: ProviderExecutionEvent[] = [];
    let steered: Promise<ChatSteerOutcome> | undefined;
    let ids = 0;
    const turn = (submissionId: string, body: string, messages?: { user: ChatMessage; assistant: ChatMessage }) => ({
      submissionId, timestamp: 1, rawDisplayText: body, canonicalText: body, images: [],
      configuration: request().configuration, toolPolicy: { kind: 'provider-default' as const }, ...(messages ? { messages } : {}),
    });
    const coordinator: ChatExecutionCoordinator = new ChatExecutionCoordinator({
      lifecycleRegistry: new ProviderExecutionLifecycleRegistry(), resolveBackend: () => backend,
      persistence: env.repository, workingDirectory: env.root, createId: () => `execution-${++ids}`,
      resolveMissingProviderSession: async () => 'preserved',
      interactionPort: { requestApproval: async request => ({ interactionId: request.interactionId, decision: 'allow' }), askUserQuestion: async request => ({ interactionId: request.interactionId, answers: {} }), dismissInteraction() {} },
      onRequestedEvent: event => {
        events.push(event);
        if (event.type === 'text_delta' && event.text === 'Working') steered ??= coordinator.steer(turn('user-steer', 'Also check tests'));
      },
    });
    const user: ChatMessage = { id: 'user', role: 'user', content: text, timestamp: 1 };
    const assistant: ChatMessage = { id: 'assistant', role: 'assistant', content: '', timestamp: 2 };
    try {
      await coordinator.bindConversation({ conversationId: conversation.id, providerId: 'opencode' });
      const result = await coordinator.execute(turn('user-main', text, { user, assistant }));
      expect(result.status).toBe('completed');
      await expect(steered).resolves.toEqual({ delivery: 'accepted' });
      const [prompt, steer] = events.filter(event => event.type === 'user_message_started');
      expect(steer).toMatchObject({ content: 'Also check tests' });
      expect(user.userMessageId).toBe(prompt.nativeUserMessageId);
      expect(user.userMessageId).not.toBe(steer.nativeUserMessageId);
      expect(assistant.assistantMessageId).toMatch(/^msg_assistant_/);
    } finally { await coordinator.dispose(); await serverService.dispose(); await env.dispose(); }
  });
});
