// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}


import { createFixture, request } from '@test/helpers/providers/opencode/OpencodeHTTPExecutionFixture';

import { type ProviderExecutionEvent } from '@/core/execution';

it('runs YOLO with automatic native approvals while still answering questions, then asks again', async () => {
  const f = await createFixture();
  try {
    for (const permissionMode of ['yolo', 'normal']) {
      const turn = request();
      const events: ProviderExecutionEvent[] = [];
      for await (const event of f.session.execute({
        ...turn, configuration: { ...turn.configuration, permissionMode },
      }).events) events.push(event);
      expect(events.at(-1)?.type).toBe('turn_completed');
      expect(f.approvals).toHaveLength(permissionMode === 'yolo' ? 0 : 1);
    }
    expect(f.questions).toEqual([expect.objectContaining({ kind: 'question' }), expect.objectContaining({ kind: 'question' })]);
  } finally { await f.dispose(); }
});

it('runs Ask and YOLO on a native build agent, changing only the approval policy', async () => {
  const f = await createFixture(false, undefined, 'ECHO_AGENTS=1');
  try {
    const selected: string[][] = [];
    for (const permissionMode of ['normal', 'yolo', 'normal']) {
      const turn = request('agents');
      const events: ProviderExecutionEvent[] = [];
      for await (const event of f.session.execute({ ...turn, configuration: { ...turn.configuration, permissionMode } }).events) events.push(event);
      expect(events.at(-1)?.type).toBe('turn_completed');
      selected.push(JSON.parse(events.flatMap(event => event.type === 'text_delta' ? [event.text] : []).join('')));
    }
    const agents = selected.at(-1)!;
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every(agent => /^build-/.test(agent))).toBe(true);
    expect(new Set(agents).size).toBe(1);
  } finally { await f.dispose(); }
});

it('allows a slash command to wait for approval beyond the ordinary HTTP deadline', async () => {
  vi.useFakeTimers({ toNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'performance'] });
  let reached!: () => void, release!: () => void;
  const requested = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await createFixture(false, async () => { reached(); await gate; });
  try {
    const events: ProviderExecutionEvent[] = [];
    const done = (async () => { for await (const event of f.session.execute(request('/review slow')).events) events.push(event); })();
    await requested;
    await vi.advanceTimersByTimeAsync(31_000);
    release();
    await done;
    expect(events.at(-1)?.type).toBe('turn_completed');
  } finally { release(); vi.useRealTimers(); await f.dispose(); }
});

it('preserves native question-tool wording and per-question headers', async () => {
  const f = await createFixture();
  try {
    for await (const event of f.session.execute(request('question-wording')).events) {
      if (event.type === 'execution_error') throw new Error(event.message);
    }
    expect(f.questions).toEqual([expect.objectContaining({ input: { questions: [expect.objectContaining({
      header: 'Color', question: 'Which color should the report use?',
    })] } })]);
  } finally { await f.dispose(); }
});

it('routes grandchild approvals and tools through the owning descendant chain', async () => {
  const f = await createFixture();
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('nested')).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(f.approvals).toEqual([expect.objectContaining({ toolName: 'bash', description: 'shell: pwd' })]);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'tool_started', toolCallId: 'ses_grand:tool_shell', parentToolCallId: 'ses_worker:tool_nested',
      toolScope: { kind: 'subagent', subagentId: 'ses_worker:tool_nested' },
    })]));
  } finally { await f.dispose(); }
});

it('answers location-owned global MCP forms through the native global endpoint', async () => {
  const f = await createFixture();
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('mcp-form')).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text_delta', text: '{"q0":"blue"}' })]));
    expect(f.questions).toEqual([expect.objectContaining({ interactionId: 'frm_mcp', input: { questions: [expect.objectContaining({ question: 'Choose a color\n\nColor' })] } })]);
  } finally { await f.dispose(); }
});

it.each(['unsupported', 'optional', 'default', 'constrained', 'empty-multi', 'cancel-race'])('reports and cancels an owned form with unsupported %s semantics', async kind => {
  const f = await createFixture();
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request(`mcp-form-${kind}`)).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: expect.stringContaining('Unsupported OpenCode form') });
    expect(f.questions).toEqual([]);
  } finally { await f.dispose(); }
});

it('does not reopen a global form settled while its location inventory was in flight', async () => {
  const f = await createFixture();
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('mcp-form-settled')).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(f.questions).toEqual([]);
  } finally { await f.dispose(); }
});

it('replies with a selected native value even when it matches another option label', async () => {
  const f = await createFixture();
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('mcp-form-values')).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text_delta', text: '{"q0":"Blue"}' })]));
  } finally { await f.dispose(); }
});

it('serializes an own __proto__ form answer and omits inherited-only fields in the native reply body', async () => {
  const f = await createFixture(false, undefined, '', () => JSON.parse('{"__proto__":"Blue"}'));
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('proto-form')).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text_delta', text: '{"__proto__":"Blue"}' })]));
  } finally { await f.dispose(); }
});
