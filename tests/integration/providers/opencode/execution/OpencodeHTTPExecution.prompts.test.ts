// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import '@/providers';

import { capturedSelectionPrompt, capturedSelections } from '@test/helpers/capturedSelections';
import { createFixture, request, writingSkill } from '@test/helpers/providers/opencode/OpencodeHTTPExecutionFixture';
import { testDate } from '@test/helpers/testClock';

import { type ProviderExecutionEvent } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';

it.each([
  ['', 'prompt', '', {}],
  ['Inspect these images', 'prompt', 'Inspect these images', {}],
  ['/review these images', 'command', 'these images', {}],
  ['/writing these images', 'prompt', '/writing these images', writingSkill],
  ['Use /writing on these images', 'prompt', 'Use /writing on these images', { skills: [{ id: 'writing', mention: { start: 4, end: 12, text: '/writing' } }] }],
  ['Use /writing/draft.md and /writingx', 'prompt', 'Use /writing/draft.md and /writingx', {}],
  ['Explain this example:\n```\n/writing\n```', 'prompt', 'Explain this example:\n```\n/writing\n```', {}],
  ['Example: `use /writing here`', 'prompt', 'Example: `use /writing here`', {}],
  ['    /writing', 'prompt', '    /writing', {}],
  ['Use /writing after `example /writing here`', 'prompt', 'Use /writing after `example /writing here`', { skills: [{ id: 'writing', mention: { start: 4, end: 12, text: '/writing' } }] }],
  ['Use /writing.probe, then /writing.', 'prompt', 'Use /writing.probe, then /writing.', { skills: [
    { id: 'writing.probe', mention: { start: 4, end: 18, text: '/writing.probe' } },
    { id: 'writing', mention: { start: 25, end: 33, text: '/writing' } },
  ] }],
  ['/unknown these images', 'prompt', '/unknown these images', {}],
])('sends images through the native HTTP boundary for %j', async (text, route, nativeText, attachments) => {
  // Exercise the command idle/history fallback while its SSE start and output are still in flight.
  const f = await createFixture(false, undefined, `ECHO_PROMPT=1\nECHO_EVENT_DELAY_MS=${route === 'command' ? 100 : 0}`);
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute({
      ...request(text),
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
    }).events) events.push(event);
    expect(events.at(-1)?.type).toBe('turn_completed');
    const received = JSON.parse(events.flatMap(event => event.type === 'text_delta' ? [event.text] : []).join(''));
    const nativeIdentity = { prompt: { id: expect.any(String) }, command: { name: 'review' } };
    expect(received).toEqual({
      route: `/api/session/ses_test/${route}`,
      body: {
        ...(route === 'command' ? nativeIdentity.command : nativeIdentity.prompt),
        text: nativeText,
        files: [{ uri: 'data:image/png;base64,aGVsbG8=' }, { uri: 'data:image/webp;base64,d29ybGQ=' }],
        ...attachments,
      },
    });
  } finally { await f.dispose(); }
});

it.each([
  ['', 'default', { providerID: 'deepseek', id: 'chat' }, []],
  ['high', 'high', { providerID: 'deepseek', id: 'chat', variant: 'high' }, [{ value: 'high', label: 'High' }, { value: 'default', label: 'Default' }]],
])('selects native model variant %j and publishes the selected model thinking levels', async (variants, reasoning, model, thinking) => {
  const f = await createFixture(false, undefined, `ECHO_MODELS=1\nMODEL_VARIANTS=${variants}`);
  try {
    const turn = request('models');
    const run = async (level: string) => {
      const events: ProviderExecutionEvent[] = [];
      for await (const event of f.session.execute({ ...turn, configuration: { ...turn.configuration, reasoning: level } }).events) events.push(event);
      return events;
    };
    const events = await run(reasoning);
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(JSON.parse(events.flatMap(event => event.type === 'text_delta' ? [event.text] : []).join(''))).toEqual(model);
    expect(getOpencodeProviderSettings(f.plugin.settings).thinkingOptionsByModel['deepseek/chat']).toEqual(thinking);
    expect((await run('max')).at(-1)).toMatchObject({ message: expect.stringContaining('does not support thinking level "max"') });
  } finally { await f.dispose(); }
}, 15000);

it('waits for account activation before replacing the catalog on a resumed first turn', async () => {
  const f = await createFixture(true, undefined, 'ACTIVATION_DELAY_MS=250\nFIRST_CATALOG_EMPTY=1');
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request()).events) events.push(event);
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(events.filter(event => event.type === 'text_delta').map(event => event.text).join('')).toBe('Finished review');
  } finally { await f.dispose(); }
});

it('executes a selected title model through the real resolver and native backend', async () => {
  const f = await createFixture();
  f.settings.titleGenerationModel = 'opencode:deepseek/chat';
  const turn = request('Generate a title');
  const selection = ProviderRegistry.resolveTitleGenerationSelection(f.plugin.settings)!;
  const model = selection.model;
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute({
      ...turn, configuration: { ...turn.configuration, model },
    }).events) events.push(event);
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(events.filter(event => event.type === 'text_delta').map(event => event.text).join('')).toBe('Finished review');
  } finally {
    await f.dispose();
  }
});

it('attaches only skills the user typed when the prompt carries history and captured context', async () => {
  const f = await createFixture(false, undefined, 'ECHO_PROMPT=1');
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute({
      ...request('Polish with /writing'),
      conversationHistory: [{ id: 'old-user', role: 'user', content: 'Earlier /writing draft', timestamp: testDate().getTime() }],
      context: { selections: [{ kind: 'editor', selection: { notePath: 'note.md', mode: 'selection', selectedText: 'Try /writing later' } }] },
    }).events) events.push(event);
    const received = JSON.parse(events.flatMap(event => event.type === 'text_delta' ? [event.text] : []).join(''));
    const start = received.body.text.indexOf('User: Polish with /writing') + 'User: Polish with '.length;
    expect(start).toBeGreaterThan('User: Polish with '.length);
    expect(received.body.skills).toEqual([{ id: 'writing', mention: { start, end: start + 8, text: '/writing' } }]);
  } finally { await f.dispose(); }
});

it('sends Linked content, captures, and hidden session references without changing native CWD', async () => {
  const f = await createFixture(false, undefined, 'ECHO_PROMPT=1\nECHO_CWD=1');
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute({
      ...request('ref @"Review"'),
      context: { ...capturedSelections, linkedContent: { path: 'Projects/Research' }, sessionReferences: [{ id: 'conv-1-ref', title: 'Review', providerId: 'codex', updatedAt: 'updated' }] },
    }).events) events.push(event);
    const received = JSON.parse(events.flatMap(event => event.type === 'text_delta' ? [event.text] : []).join(''));
    expect(received.cwd).toBe(f.root);
    expect(received.body.text).toBe('ref @"Review"\n\n<linked_content path="Projects/Research" />\n\n' + capturedSelectionPrompt + '\n\n<context_sessions>\n<context_session title="Review" id="conv-1-ref" provider="codex" updated="updated" />\n</context_sessions>');
  } finally { await f.dispose(); }
});
