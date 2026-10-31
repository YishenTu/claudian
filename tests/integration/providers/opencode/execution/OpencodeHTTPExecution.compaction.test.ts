// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createFixture, NATIVE_STARTUP_TIMEOUT_MS, request } from '@test/helpers/providers/opencode/OpencodeHTTPExecutionFixture';
import { testDate } from '@test/helpers/testClock';

import { isSteerableExecutionSession, type ProviderExecutionEvent } from '@/core/execution';

it.each([
  { beforeResponse: false, staleFailure: false },
  { beforeResponse: true, staleFailure: false },
  { beforeResponse: false, staleFailure: true },
  { beforeResponse: true, staleFailure: true },
])('compacts through the native endpoint (events before admission: $beforeResponse, stale failure: $staleFailure)', async ({ beforeResponse, staleFailure }) => {
  const f = await createFixture(true, undefined, `COMPACT_BEFORE_RESPONSE=${beforeResponse ? '1' : '0'}\nSTALE_COMPACT_FAILURE=${staleFailure ? '1' : '0'}`);
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('/compact')).events) events.push(event);
    expect(events.filter(event => event.type === 'context_compacted')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(events.some(event => event.type === 'text_delta' || event.type === 'user_message_started')).toBe(false);
    expect(events.find(event => event.type === 'turn_started')).not.toHaveProperty('nativeUserMessageId');
    expect(f.approvals).toEqual([]);
    expect(f.questions).toEqual([]);
  } finally { await f.dispose(); }
});

it.each([
  ['http-error', 'Cannot compact this session'],
  ['failed', 'Compaction model failed'],
])('reports native compaction failure (%s)', async (outcome, message) => {
  const f = await createFixture(true, undefined, `COMPACT_OUTCOME=${outcome}`);
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('/compact')).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: expect.stringContaining(message) });
    expect(events.some(event => event.type === 'context_compacted' || event.type === 'turn_completed')).toBe(false);
  } finally { await f.dispose(); }
});

it('rejects compact arguments unsupported by the native endpoint', async () => {
  const f = await createFixture(true);
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('/compact keep recent edits')).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: expect.stringContaining('/compact does not accept arguments') });
  } finally { await f.dispose(); }
});

it('cancels native compaction, declines steering, and can continue the session', async () => {
  const started = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-http-compact-'))), 'started');
  const f = await createFixture(true, undefined, `COMPACT_STARTED_FILE=${started}`);
  try {
    const run = f.session.execute(request('/compact'));
    const events: ProviderExecutionEvent[] = [];
    const consumed = (async () => { for await (const event of run.events) events.push(event); })();
    const deadline = Date.now() + NATIVE_STARTUP_TIMEOUT_MS;
    while (!existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(started)).toBe(true);
    if (!isSteerableExecutionSession(f.session)) throw new Error('Missing steering');
    await expect(f.session.steer(request('Also check tests'))).resolves.toBe(false);
    run.cancel();
    await consumed;
    expect(events.at(-1)?.type).toBe('cancelled');
    expect(events.some(event => event.type === 'context_compacted')).toBe(false);
    const continued: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('continue')).events) continued.push(event);
    expect(continued.at(-1)?.type).toBe('turn_completed');
  } finally { await f.dispose(); rmSync(path.dirname(started), { recursive: true, force: true }); }
});

it.each(['/compact', ' \t/CoMpAcT  '])('compacts %j with captured editor context', async text => {
  const f = await createFixture(true);
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute({
      ...request(text),
      context: { selections: [{ kind: 'editor', selection: { notePath: 'note.md', mode: 'selection', selectedText: 'selected note text' } }] },
    }).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(events.filter(event => event.type === 'context_compacted')).toHaveLength(1);
  } finally { await f.dispose(); }
});

it('requires replaying recovered context before compacting a replacement native session', async () => {
  const f = await createFixture();
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute({
      ...request('/compact'),
      conversationHistory: [{ id: 'old-user', role: 'user', content: 'Earlier conversation', timestamp: testDate().getTime() }],
    }).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: expect.stringContaining('normal message') });
    expect(events.some(event => event.type === 'context_compacted')).toBe(false);
  } finally { await f.dispose(); }
});

it.each([0, 150])('recalls a queued compact before continuing after cancellation (admission delay: %s)', async delay => {
  const queued = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-queued-compact-'))), 'queued');
  const f = await createFixture(true, undefined, `COMPACT_QUEUED_FILE=${queued}\nCOMPACT_ADMISSION_DELAY=${delay}`);
  try {
    const run = f.session.execute(request('/compact'));
    const events: ProviderExecutionEvent[] = [];
    const consumed = (async () => { for await (const event of run.events) events.push(event); })();
    const deadline = Date.now() + NATIVE_STARTUP_TIMEOUT_MS;
    while (!existsSync(queued) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(queued)).toBe(true);
    // For the zero-delay case let the HTTP admission response arrive before cancelling.
    if (!delay) await new Promise(resolve => setTimeout(resolve, 30));
    run.cancel();
    await consumed;
    expect(events.at(-1)?.type).toBe('cancelled');
    const continued: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('continue')).events) continued.push(event);
    expect(continued.at(-1)?.type).toBe('turn_completed');
    expect(continued.some(event => event.type === 'context_compacted')).toBe(false);
  } finally { await f.dispose(); rmSync(path.dirname(queued), { recursive: true, force: true }); }
});
