import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createFixture, request } from '@test/helpers/providers/opencode/OpencodeHTTPExecutionFixture';

import { type ProviderExecutionEvent } from '@/core/execution';

it('uses HTTP for v2 commands, waits for execution completion, and answers native interactions', async () => {
  const f = await createFixture();
  const { session, approvals, questions } = f;
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of session.execute(request()).events) events.push(event);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text_delta' })]));
    expect(events.filter(e => e.type === 'text_delta').map(e => e.text).join('')).toBe('Finished review');
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'usage_updated', usage: expect.objectContaining({ contextTokens: 165, contextWindow: 1000, percentage: 17 }) })]));
    // Statistics come from the native message API: output plus reasoning over the user-to-completion span.
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'turn_completed', turnStats: { outputTokens: 35, durationMs: 1234 } }));
    expect(approvals).toEqual([expect.objectContaining({ kind: 'approval' })]);
    expect(questions).toEqual([expect.objectContaining({ kind: 'question', input: expect.objectContaining({ questions: expect.any(Array) }) })]);
    expect(session.getSnapshot()).toMatchObject({ providerSessionId: 'ses_test' });
  } finally { await f.dispose(); }
});

it('reads turn statistics from the newest native page without fetching older history', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-http-history-')));
  const log = path.join(root, 'requests');
  // More earlier history than one native page can hold.
  const f = await createFixture(false, undefined, `SEED_HISTORY=450\nREQUEST_LOG=${log}`);
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('stats')).events) events.push(event);
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'turn_completed', turnStats: { outputTokens: 35, durationMs: 1234 } }));
    const reads = readFileSync(log, 'utf8').split('\n').filter(line => line.includes('/message'));
    expect(reads).toHaveLength(1);
    expect(reads[0]).not.toContain('cursor=');
  } finally { await f.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 15000);

it.each([
  // Native completion stands; cancellation cannot rewrite it while statistics load.
  ['cancellation arrives', '', (run: { cancel(): void }) => run.cancel(), { turnStats: { outputTokens: 35, durationMs: 1234 } }, 'idle'],
  // Statistics die with the stream, and the next turn must reopen the native runtime.
  ['the native event stream closes', 'CLOSE_EVENTS_ON_HOLD=1', () => undefined, {}, 'invalidated'],
] as const)('keeps native completion when %s while turn statistics load', async (_, environment, interrupt, stats, status) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-http-history-')));
  const hold = path.join(root, 'history'), log = path.join(root, 'requests');
  const f = await createFixture(false, undefined, `HOLD_HISTORY=${hold}\nREQUEST_LOG=${log}\n${environment}`);
  try {
    const run = f.session.execute(request('stats'));
    const events: ProviderExecutionEvent[] = [];
    const consumed = (async () => { for await (const event of run.events) events.push(event); })();
    // The history read starts only after native success.
    const deadline = Date.now() + 3000;
    while (!existsSync(hold) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(hold)).toBe(true);
    interrupt(run);
    await new Promise(resolve => setTimeout(resolve, 50));
    rmSync(hold);
    await consumed;
    expect(events.at(-1)).toEqual({ type: 'turn_completed', reason: 'completed', ...stats, scope: expect.any(Object) });
    expect(readFileSync(log, 'utf8')).not.toContain('/interrupt');
    expect(f.session.getStatus()).toBe(status);
  } finally { await f.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 15000);

it('interrupts HTTP execution and continues the same native session on the next turn', async () => {
  const f = await createFixture();
  try {
    const run = f.session.execute(request('cancel'));
    const cancelled: ProviderExecutionEvent[] = [];
    for await (const event of run.events) {
      cancelled.push(event);
      if (event.type === 'text_delta') run.cancel();
    }
    expect(cancelled.at(-1)?.type).toBe('cancelled');
    const continued: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('continue')).events) continued.push(event);
    expect(continued.at(-1)?.type).toBe('turn_completed');
    expect(f.session.getSnapshot()).toMatchObject({ providerSessionId: 'ses_test' });
  } finally { await f.dispose(); }
});

it('keeps a turn cancelled during configuration from changing the next turn approval policy', async () => {
  const hold = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-http-hold-'))), 'model');
  const f = await createFixture(false, undefined, `HOLD_SECOND_MODEL=${hold}`);
  try {
    for await (const event of f.session.execute(request()).events) void event;
    expect(f.approvals).toHaveLength(1);
    const yolo = request();
    const cancelled = f.session.execute({ ...yolo, configuration: { ...yolo.configuration, permissionMode: 'yolo' } });
    const cancelledEvents: ProviderExecutionEvent[] = [];
    const consumed = (async () => { for await (const event of cancelled.events) cancelledEvents.push(event); })();
    const deadline = Date.now() + 3000;
    while (!existsSync(hold) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(hold)).toBe(true);
    cancelled.cancel();
    await consumed;
    expect(cancelledEvents.at(-1)?.type).toBe('cancelled');
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request()).events) events.push(event);
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(f.approvals).toHaveLength(2);
  } finally { await f.dispose(); rmSync(path.dirname(hold), { recursive: true, force: true }); }
});

it('loads a bound native session without injecting old conversation history into its prompt', async () => {
  const f = await createFixture(true);
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute({ ...request('continue'), conversationHistory: [{ id: 'old', role: 'user', content: 'Old local history', timestamp: 1 }] }).events) events.push(event);
    expect(events.filter(event => event.type === 'text_delta').map(event => event.text).join('')).toBe('Finished review');
    expect(events.at(-1)?.type).toBe('turn_completed');
  } finally { await f.dispose(); }
});

it('reports a disconnected event stream as a failed turn instead of successful completion', async () => {
  const f = await createFixture();
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('disconnect')).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', recoverable: true });
    expect(f.session.getStatus()).toBe('invalidated');
  } finally { await f.dispose(); }
});

it('keeps repeated native tool IDs distinct across assistant messages and turns', async () => {
  const f = await createFixture();
  try {
    for (const text of ['first', 'second']) {
      const events: ProviderExecutionEvent[] = [];
      for await (const event of f.session.execute(request(text)).events) events.push(event);
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_completed', toolCallId: 'reused_tool', content: 'Read result' })]));
    }
  } finally { await f.dispose(); }
});
