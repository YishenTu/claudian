import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';

import { type ProviderExecutionEvent, ProviderExecutionLifecycleRegistry, type ProviderExecutionRequest, type ProviderSessionEvent } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { providerOutputEventToStreamChunk } from '@/features/chat/controllers/StreamController';
import { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';

// Native HTTP boundary, based on v2.0.12 event and route contracts.
const fixture = `#!/usr/bin/env node
const http = require('node:http');
if (process.argv.includes('--version')) { console.log('opencode v2.0.12'); return; }
if (!process.argv.includes('serve')) process.exit(3);
let lateChild, feed, permission, grandApproval, form, mcpAnswer, settleInventory = false, cancelRace = false, ownedForms = [], idle = true, waiter, messages = [], turn = 0;
let activated = !process.env.ACTIVATION_DELAY_MS, activation;
const emit = (type, data) => feed.write('data: ' + JSON.stringify({ type, data: { sessionID: 'ses_test', ...data } }) + '\\n\\n');
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64')) { res.writeHead(403).end(); return; }
  let raw = ''; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const route = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Content-Type', 'application/json');
  if (route === '/api/event') { feed = res; res.setHeader('Content-Type', 'text/event-stream'); emit('server.connected', {}); return; }
  if (route === '/api/agent') {
    const base = JSON.parse(require('node:fs').readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
    const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
    res.end(JSON.stringify({ data: [...Object.entries(inline.agent || {}).map(([id, agent]) => ({ id, system: agent.prompt })), ...Object.entries(base.agents || {}).map(([id, agent]) => ({ id, ...agent }))] })); return;
  }
  if (route === '/api/integration' || route === '/api/model') {
    activation ??= new Promise(resolve => setTimeout(() => { activated = true; resolve(); }, Number(process.env.ACTIVATION_DELAY_MS || 0)));
    if (route === '/api/integration') { await activation; res.end(JSON.stringify({ data: [] })); return; }
    res.end(JSON.stringify({ data: activated
      ? [{ id: 'chat', providerID: 'deepseek', name: 'Chat', enabled: true, variants: [], limit: { context: 1000 } }]
      : [{ id: 'builtin', providerID: 'opencode', name: 'Builtin', enabled: true, variants: [] }] })); return;
  }
  if (route === '/api/command') { res.end(JSON.stringify({ data: [{ name: 'review', description: 'Review' }] })); return; }
  if (route === '/api/form') {
    const snapshot = [...ownedForms];
    if (settleInventory) {
      emit('form.cancelled', { sessionID: 'global', id: 'frm_mcp' }); mcpAnswer = 'cancelled';
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    res.end(JSON.stringify({ data: snapshot })); return;
  }
  if (route === '/api/session/global/form/frm_mcp/reply') { mcpAnswer = body.answer; emit('form.replied', { sessionID: 'global', id: 'frm_mcp' }); res.writeHead(204).end(); return; }
  if (route === '/api/session/global/form/frm_mcp' && req.method === 'DELETE') { mcpAnswer = 'cancelled'; emit('form.cancelled', { sessionID: 'global', id: 'frm_mcp' }); if (cancelRace) await new Promise(resolve => setTimeout(resolve, 30)); res.writeHead(204).end(); return; }
  if (route === '/api/mcp') { res.end(JSON.stringify({ data: [] })); return; }
  if (route === '/api/session' && process.env.EXPECT_RESUME === '1') { res.writeHead(409).end(); return; }
  if (route === '/api/session' || (route === '/api/session/ses_test' && req.method === 'GET')) { res.end(JSON.stringify({ data: { id: 'ses_test' } })); return; }
  if (route.endsWith('/interrupt')) { emit('session.execution.interrupted', { reason: 'user' }); res.end(JSON.stringify({ interrupted: true })); return; }
  if (route.endsWith('/model') || route.endsWith('/agent')) { if (process.env.LATE_CHILD_STAGE === 'configuration') lateChild?.(); res.writeHead(204).end(); return; }
  if (route === '/api/session/ses_grand/permission/per_grand/reply') { grandApproval = body.decision; res.writeHead(204).end(); return; }
  if (route.endsWith('/permission/per_test/reply')) { permission = body.decision; res.writeHead(204).end(); return; }
  if (route.endsWith('/form/frm_test/reply')) { form = body.answer; res.writeHead(204).end(); return; }
  if (route.endsWith('/message')) { res.end(JSON.stringify({ data: messages, cursor: {} })); return; }
  if (route.endsWith('/wait')) { if (idle) res.writeHead(204).end(); else waiter = res; return; }
  if (route.endsWith('/prompt') || route.endsWith('/command')) {
    if (body.text.includes('Old local history')) { res.writeHead(400).end(); return; }
    const assistantMessageID = 'msg_assistant_' + (++turn);
    idle = false; res.end(JSON.stringify({ data: { id: 'msg_user' } }));
    if (process.env.LATE_CHILD_STAGE === 'prompt') lateChild?.();
    setTimeout(async () => {
      emit('session.execution.started', {});
      emit('session.step.started', { assistantMessageID });
      if (body.text.startsWith('mcp-form')) {
        const nativeForm = { id: 'frm_mcp', sessionID: 'global', title: 'probe is requesting input', metadata: { kind: 'mcp-elicitation', server: 'probe', message: 'Choose a color' }, fields: [{ key: 'q0', type: (body.text.endsWith('unsupported') || body.text.endsWith('cancel-race')) ? 'external' : 'string', title: 'Color', options: [{ label: 'Blue', value: 'blue' }], custom: false, required: true }] };
        if (body.text.endsWith('values')) nativeForm.fields[0].options = [{ value: 'Blue', label: 'Red' }, { value: 'green', label: 'Blue' }];
        if (body.text.endsWith('optional')) nativeForm.fields[0].required = false;
        if (body.text.endsWith('default')) nativeForm.fields[0].default = 'blue';
        if (body.text.endsWith('constrained')) nativeForm.fields[0].maxLength = 2;
        if (body.text.endsWith('empty-multi')) nativeForm.fields[0].type = 'multiselect';
        if (body.text === 'mcp-form-late') emit('session.execution.succeeded', {});
        cancelRace = body.text.endsWith('cancel-race');
        settleInventory = body.text === 'mcp-form-settled';
        ownedForms = [nativeForm];
        emit('form.created', { form: { ...nativeForm, id: 'frm_other_location' } });
        emit('form.created', { form: nativeForm });
        const deadline = Date.now() + 500;
        while (!mcpAnswer && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
        if (settleInventory || cancelRace) await new Promise(resolve => setTimeout(resolve, 70));
        if (!mcpAnswer) emit('session.execution.failed', { error: { message: 'MCP form never settled' } });
        else { if (body.text === 'mcp-form-late') emit('session.execution.started', {}); emit('session.text.ended', { assistantMessageID, ordinal: 0, text: body.text === 'mcp-form-late' ? 'Automatic reply' : JSON.stringify(mcpAnswer) }); emit('session.execution.succeeded', {}); }
        return;
      }
      if (body.text === 'nested') {
        for (const [owner, target, id] of [['ses_test', 'ses_worker', 'tool_worker'], ['ses_worker', 'ses_grand', 'tool_nested']]) {
          emit('session.tool.input.started', { sessionID: owner, assistantMessageID, id, name: 'subagent' });
          emit('session.tool.called', { sessionID: owner, assistantMessageID, id, input: { agent: 'worker' } });
          emit('session.tool.progress', { sessionID: owner, assistantMessageID, id, metadata: { sessionID: target, status: 'running' } });
        }
        emit('session.tool.input.started', { sessionID: 'ses_grand', assistantMessageID, id: 'tool_shell', name: 'shell' });
        emit('session.tool.called', { sessionID: 'ses_grand', assistantMessageID, id: 'tool_shell', input: { command: 'pwd' } });
        emit('permission.asked', { sessionID: 'ses_grand', id: 'per_grand', action: 'shell', resources: ['pwd'] });
        const deadline = Date.now() + 500;
        while (!grandApproval && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
        emit(grandApproval === 'once' ? 'session.execution.succeeded' : 'session.execution.failed', { error: { message: 'Nested approval was not answered' } });
        return;
      }
      if (body.text === 'cancel') { emit('session.text.delta', { assistantMessageID, ordinal: 0, delta: 'Waiting' }); return; }
      if (body.text === 'disconnect') { feed.end(); return; }
      emit('permission.asked', { id: 'per_test', action: 'shell', resources: ['echo test'] });
      if (body.text === 'question-wording') {
        emit('form.created', { form: { id: 'frm_test', sessionID: 'ses_test', title: 'Questions', metadata: { kind: 'question' }, fields: [{ key: 'q0', type: 'string', title: 'Color', description: 'Which color should the report use?', custom: true, options: [{ value: 'blue', label: 'Blue' }] }] } });
      }
      if (body.text !== 'slow' && body.text !== 'question-wording') emit('form.created', { form: { id: 'frm_test', sessionID: 'ses_test', title: 'Color', fields: [{ key: 'q0', type: 'string', title: 'Pick a color', options: [{ value: 'blue', label: 'Blue' }] }] } });
      const start = Date.now();
      while ((!permission || (!form && body.text !== 'slow')) && Date.now() - start < 1500) await new Promise(r => setTimeout(r, 10));
      if (permission !== 'once' || (body.text !== 'slow' && form?.q0 !== 'blue')) { emit('session.execution.failed', { error: { message: 'Interactions not answered' } }); return; }
      if (body.text.startsWith('background')) {
        emit('session.tool.input.started', { assistantMessageID, id: 'tool_child', name: 'subagent' });
        emit('session.tool.called', { assistantMessageID, id: 'tool_child', input: { background: true, agent: 'worker' } });
        emit('session.tool.progress', { assistantMessageID, id: 'tool_child', metadata: { sessionID: 'ses_child', status: 'running' } });
        emit('session.tool.success', { assistantMessageID, id: 'tool_child', content: [{ type: 'text', text: 'Background child launched' }], metadata: { sessionID: 'ses_child', status: 'background' } });
        emit('session.tool.input.started', { sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'tool_read', name: 'read' });
        emit('session.tool.called', { sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'tool_read', input: { path: '/workspace/notes.md' } });
        emit('session.tool.success', { sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'tool_read', content: [{ type: 'text', text: 'Child read result' }] });
        if (body.text === 'background-overlap') {
          lateChild = () => {
            lateChild = undefined;
            emit('session.tool.input.started', { sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'late_read', name: 'read' });
            emit('session.tool.called', { sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'late_read', input: { path: '/workspace/late.md' } });
            emit('session.tool.success', { sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'late_read', content: [{ type: 'text', text: 'Late child result' }] });
            emit('session.execution.succeeded', { sessionID: 'ses_child' });
          };
        } else setTimeout(async () => {
          if (body.text === 'background-approval' || body.text === 'background-nested') {
            const interactionSession = body.text === 'background-nested' ? 'ses_grand' : 'ses_child';
            if (body.text === 'background-nested') {
              emit('session.tool.input.started', { sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'nested', name: 'subagent' });
              emit('session.tool.called', { sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'nested', input: { agent: 'worker', background: true } });
              emit('session.tool.progress', { sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'nested', metadata: { sessionID: 'ses_grand', status: 'running' } });
              emit('session.text.ended', { sessionID: 'ses_child', assistantMessageID: 'msg_child', ordinal: 0, text: 'Child result' });
              emit('session.execution.succeeded', { sessionID: 'ses_child' });
            }
            permission = undefined; form = undefined;
            emit('permission.asked', { sessionID: interactionSession, id: 'per_test', action: 'shell', resources: ['echo child'] });
            emit('form.created', { form: { id: 'frm_test', sessionID: interactionSession, title: 'Child color', fields: [{ key: 'q0', type: 'string', title: 'Pick a child color', options: [{ value: 'blue', label: 'Blue' }] }] } });
            const deadline = Date.now() + 3000;
            while ((!permission || !form) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
            if (permission !== 'once' || form?.q0 !== 'blue') return;
            if (body.text === 'background-nested') emit('session.execution.succeeded', { sessionID: 'ses_grand' });
          }
          emit('session.text.ended', { sessionID: 'ses_child', assistantMessageID: 'msg_child', ordinal: 0, text: 'Child result' });
          emit('session.execution.succeeded', { sessionID: 'ses_child' });
          emit('session.execution.started', {});
          emit('session.text.ended', { assistantMessageID: 'msg_background', ordinal: 0, text: 'Automatic reply' });
          emit('session.execution.succeeded', {});
        }, 50);
      }
      emit('session.tool.input.started', { assistantMessageID, id: 'reused_tool', name: 'read' });
      emit('session.tool.called', { assistantMessageID, id: 'reused_tool', input: { path: '/workspace/notes.md' } });
      emit('session.tool.success', { assistantMessageID, id: 'reused_tool', content: [{ type: 'text', text: 'Read result' }] });
      emit('session.text.delta', { assistantMessageID, ordinal: 0, delta: 'Finished ' });
      emit('session.text.ended', { assistantMessageID, ordinal: 0, text: 'Finished review' });
      emit('session.step.ended', { tokens: { input: 100, output: 30, reasoning: 5, cache: { read: 20, write: 10 } } });
      messages = [{ id: assistantMessageID, type: 'assistant', tokens: { input: 100, output: 30, reasoning: 5, cache: { read: 20, write: 10 } }, content: [{ type: 'text', text: 'Finished review' }] }];
      emit('session.execution.succeeded', {}); idle = true; waiter?.writeHead(204).end();
    }, 50); return;
  }
  res.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port })));
process.stdin.resume(); process.stdin.on('end', () => server.close());
`;

function createFixture(resume = false, approval?: (signal: AbortSignal) => Promise<void>, environmentVariables = '') {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-http-execution-')));
  const cliPath = path.join(root, 'opencode.cjs');
  writeFileSync(cliPath, fixture, { mode: 0o700 });
  const plugin: any = {
    settings: { model: 'opencode:deepseek/chat', providerConfigs: { opencode: { enabled: true, visibleModels: ['deepseek/chat'], discoveredModels: [{ rawId: 'deepseek/chat', label: 'DeepSeek' }], environmentVariables: [resume ? 'EXPECT_RESUME=1' : '', environmentVariables].join('\n') } } },
    getResolvedProviderCliPath: async () => cliPath,
    mutateSettings: async (fn: (settings: unknown) => void) => fn(plugin.settings),
    mutateSettingsConditionally: async (fn: (settings: unknown) => void) => fn(plugin.settings),
    notifyProviderChatOptionsChanged() {},
  };
  const approvals: unknown[] = [], questions: unknown[] = [];
  const serverService = new OpencodeServerService();
  const session = new OpencodeExecutionBackend(plugin, { serverService }).createSession({
    ...(resume ? { resumeSeed: { providerSessionId: 'ses_test', providerState: { nativeVersion: 2 } } } : {}),
    vaultWorkingDirectory: root, lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported',
    interactionPort: {
      requestApproval: async (request, signal) => { approvals.push(request); await approval?.(signal); return { interactionId: request.interactionId, decision: 'allow' }; },
      askUserQuestion: async request => { questions.push(request); const questionsInput = request.input.questions; return { interactionId: request.interactionId, answers: { q0: Array.isArray(questionsInput) ? questionsInput[0].options[0].value : '' } }; },
      dismissInteraction() {},
    },
  });
  return { plugin, session, approvals, questions, async dispose() { await session.dispose(); await serverService.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

function request(text = '/review changes'): ProviderExecutionRequest {
  return {
    input: [{ type: 'text', text }],
    configuration: { model: 'opencode:deepseek/chat', permissionMode: 'normal', systemInstructions: { kind: 'explicit', instructions: 'Review changes.' } },
    toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal,
  };
}

it('runs YOLO with automatic native approvals while still answering questions', async () => {
  const f = createFixture(false, async () => { throw new Error('Manual approvals are unavailable'); });
  try {
    const turn = request();
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute({
      ...turn, configuration: { ...turn.configuration, permissionMode: 'yolo' },
    }).events) events.push(event);
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(f.questions).toEqual([expect.objectContaining({ kind: 'question' })]);
  } finally { await f.dispose(); }
}, 15000);

it('waits for account activation before replacing the catalog on a resumed first turn', async () => {
  const f = createFixture(true, undefined, 'ACTIVATION_DELAY_MS=250');
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request()).events) events.push(event);
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(events.filter(event => event.type === 'text_delta').map(event => event.text).join('')).toBe('Finished review');
  } finally { await f.dispose(); }
});

it('uses HTTP for v2 commands, waits for execution completion, and answers native interactions', async () => {
  const f = createFixture();
  const { session, approvals, questions } = f;
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of session.execute(request()).events) events.push(event);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text_delta' })]));
    expect(events.filter(e => e.type === 'text_delta').map(e => e.text).join('')).toBe('Finished review');
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'usage_updated', usage: expect.objectContaining({ contextTokens: 165, contextWindow: 1000, percentage: 17 }) })]));
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(approvals).toEqual([expect.objectContaining({ kind: 'approval' })]);
    expect(questions).toEqual([expect.objectContaining({ kind: 'question', input: expect.objectContaining({ questions: expect.any(Array) }) })]);
    expect(session.getSnapshot()).toMatchObject({ providerSessionId: 'ses_test', providerState: { nativeVersion: 2 } });
  } finally { await f.dispose(); }
}, 15000);

it('delivers child completion and automatic parent replies after the requested turn', async () => {
  const f = createFixture();
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
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'async_subagent_completed', subagentId: 'ses_child', result: 'Child result', status: 'completed' }),
      expect.objectContaining({ type: 'text_delta', text: 'Automatic reply', scope: expect.objectContaining({ kind: 'background' }) }),
    ]));
  } finally { await f.dispose(); }
}, 15000);

it('interrupts HTTP execution and continues the same native session on the next turn', async () => {
  const f = createFixture();
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
}, 15000);

it('loads a bound native session without injecting old conversation history into its prompt', async () => {
  const f = createFixture(true);
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute({ ...request('continue'), conversationHistory: [{ id: 'old', role: 'user', content: 'Old local history', timestamp: 1 }] }).events) events.push(event);
    expect(events.filter(event => event.type === 'text_delta').map(event => event.text).join('')).toBe('Finished review');
    expect(events.at(-1)?.type).toBe('turn_completed');
  } finally { await f.dispose(); }
}, 15000);

it('reports a disconnected event stream as a failed turn instead of successful completion', async () => {
  const f = createFixture();
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('disconnect')).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', recoverable: true });
    expect(f.session.getStatus()).toBe('invalidated');
  } finally { await f.dispose(); }
}, 15000);

it('allows a slash command to wait for approval beyond the ordinary HTTP deadline', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'performance'] });
  let reached!: () => void, release!: () => void;
  const requested = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = createFixture(false, async () => { reached(); await gate; });
  try {
    const events: ProviderExecutionEvent[] = [];
    const done = (async () => { for await (const event of f.session.execute(request('/review slow')).events) events.push(event); })();
    await requested;
    await jest.advanceTimersByTimeAsync(31_000);
    release();
    await done;
    expect(events.at(-1)?.type).toBe('turn_completed');
  } finally { release(); jest.useRealTimers(); await f.dispose(); }
}, 15000);

it('keeps repeated native tool IDs distinct across assistant messages and turns', async () => {
  const f = createFixture();
  try {
    for (const text of ['first', 'second']) {
      const events: ProviderExecutionEvent[] = [];
      for await (const event of f.session.execute(request(text)).events) events.push(event);
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_completed', toolCallId: 'reused_tool', content: 'Read result' })]));
    }
  } finally { await f.dispose(); }
}, 15000);

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
  const backend = new OpencodeExecutionBackend(env.host, { serverService });
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
    persistence: env.repository, vaultWorkingDirectory: env.root, createId: () => 'execution-child',
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
    expect(coordinator.canCool()).toBe(false);
    await asked;
    expect(interactions).toEqual(text === 'mcp-form-late' ? ['question'] : ['approval', 'question']);
    expect(coordinator.canCool()).toBe(false);
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
}, 15000);

it('cancels a background child waiting for approval and can continue the native parent', async () => {
  let childAsked!: () => void;
  const asked = new Promise<void>(resolve => { childAsked = resolve; });
  let dismissed!: () => void;
  const dismissal = new Promise<void>(resolve => { dismissed = resolve; });
  let approvals = 0;
  const f = createFixture(false, async signal => {
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
}, 15000);

it('preserves native question-tool wording and per-question headers', async () => {
  const f = createFixture();
  try {
    for await (const event of f.session.execute(request('question-wording')).events) {
      if (event.type === 'execution_error') throw new Error(event.message);
    }
    expect(f.questions).toEqual([expect.objectContaining({ input: { questions: [expect.objectContaining({
      header: 'Color', question: 'Which color should the report use?',
    })] } })]);
  } finally { await f.dispose(); }
}, 15000);

it('routes grandchild approvals and tools through the owning descendant chain', async () => {
  const f = createFixture();
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
}, 15000);

it('answers location-owned global MCP forms through the native global endpoint', async () => {
  const f = createFixture();
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('mcp-form')).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text_delta', text: '{"q0":"blue"}' })]));
    expect(f.questions).toEqual([expect.objectContaining({ interactionId: 'frm_mcp', input: { questions: [expect.objectContaining({ question: 'Choose a color\n\nColor' })] } })]);
  } finally { await f.dispose(); }
}, 15000);

it.each(['unsupported', 'optional', 'default', 'constrained', 'empty-multi', 'cancel-race'])('reports and cancels an owned form with unsupported %s semantics', async kind => {
  const f = createFixture();
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request(`mcp-form-${kind}`)).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: expect.stringContaining('Unsupported OpenCode form') });
    expect(f.questions).toEqual([]);
  } finally { await f.dispose(); }
}, 15000);

it('does not reopen a global form settled while its location inventory was in flight', async () => {
  const f = createFixture();
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('mcp-form-settled')).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(f.questions).toEqual([]);
  } finally { await f.dispose(); }
}, 15000);

it('replies with a selected native value even when it matches another option label', async () => {
  const f = createFixture();
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of f.session.execute(request('mcp-form-values')).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text_delta', text: '{"q0":"Blue"}' })]));
  } finally { await f.dispose(); }
}, 15000);

it.each(['configuration', 'prompt'])('keeps an earlier child in its own scope during a later turn %s', async stage => {
  const f = createFixture(false, undefined, `LATE_CHILD_STAGE=${stage}`);
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
}, 15000);

it('executes a selected title model through the real resolver and native backend', async () => {
  const f = createFixture();
  f.plugin.settings.titleGenerationModel = 'opencode:deepseek/chat';
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
