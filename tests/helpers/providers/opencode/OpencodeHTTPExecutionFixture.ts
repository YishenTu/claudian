import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import { type ProviderExecutionRequest } from '@/core/execution';
import type { ManagedStdioProcessOptions } from '@/core/process/ManagedStdioProcess';
import type * as ProcessProbe from '@/core/process/ProcessProbe';
import type { AskUserAnswers } from '@/core/types';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { isRecord, OpencodeHTTPClient } from '@/providers/opencode/http/OpencodeHTTPClient';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';

// Real CLI probing, server startup and cleanup can exceed the default test timeout on Windows runners.
vi.setConfig({ testTimeout: 45_000 });

// A cold first turn includes the version probe and the HTTP server's 10-second readiness budget.
const NATIVE_STARTUP_TIMEOUT_MS = 40_000;

// Keep the native probe real, with the same cold-launch allowance as OpencodeSharedServer.
// Explicit probe deadlines still apply; this suite does not test the production default deadline.
vi.mock('@/core/process/ProcessProbe', async () => {
  const actual: typeof ProcessProbe = (await vi.importActual<typeof import('@/core/process/ProcessProbe')>('@/core/process/ProcessProbe'));
  return {
    ...actual,
    runProcessProbe: (options: ManagedStdioProcessOptions, timeoutMs = 30_000) => actual.runProcessProbe(options, timeoutMs),
  };
});

// Native HTTP boundary, based on v2.0.12 event and route contracts.
const fixture = `#!/usr/bin/env node
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const interactions = new EventEmitter();
const promptEventReleases = new Map();
// Replies synchronize the fixture; this deadline only bounds a missing reply after a regression.
const waitForInteraction = async predicate => {
  const signal = AbortSignal.timeout(30_000);
  while (!predicate()) await once(interactions, 'changed', { signal });
};
if (process.argv.includes('--version')) { console.log('opencode v2.0.12'); return; }
if (!process.argv.includes('serve')) process.exit(3);
// Like the native server, create the database it was launched with.
if (process.env.OPENCODE_DB && process.env.OPENCODE_DB !== ':memory:' && !require('node:fs').existsSync(process.env.OPENCODE_DB)) {
  require('node:fs').mkdirSync(require('node:path').dirname(process.env.OPENCODE_DB), { recursive: true });
  require('node:fs').writeFileSync(process.env.OPENCODE_DB, '');
}
let onSteer, selectedAgents = [], selectedModels = [], inbox = [], lateChild, feed, permission, grandApproval, form, mcpAnswer, settleInventory = false, cancelRace = false, ownedForms = [], idle = true, waiter, messages = [], turn = 0, modelRequests = 0, catalogReads = 0, releaseModel;
let activated = !process.env.ACTIVATION_DELAY_MS, activation;
// Earlier native turns, created before any prompt of this test.
for (let index = 0; index < Number(process.env.SEED_HISTORY || 0); index += 1) messages.push({ id: 'msg_old_' + String(index).padStart(5, '0'), type: index % 2 ? 'assistant' : 'user', time: { created: Date.now() - 60000 + index } });
const emit = (type, data) => {
  const send = () => feed.write('data: ' + JSON.stringify({ type, data: { sessionID: 'ses_test', ...data } }) + '\\n\\n');
  if (process.env.ECHO_EVENT_DELAY_MS && type.startsWith('session.')) setTimeout(send, Number(process.env.ECHO_EVENT_DELAY_MS));
  else send();
};
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64')) { res.writeHead(403).end(); return; }
  let raw = ''; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const route = new URL(req.url, 'http://localhost').pathname;
  if (process.env.REQUEST_LOG) require('node:fs').appendFileSync(process.env.REQUEST_LOG, req.method + ' ' + req.url + '\\n');
  res.setHeader('Content-Type', 'application/json');
  if (route === '/fixture/release-prompt-events') {
    const release = promptEventReleases.get(body.id);
    if (!release) { res.writeHead(409).end(); return; }
    promptEventReleases.delete(body.id); release(); res.writeHead(204).end(); return;
  }
  if (route === '/api/event') { feed = res; res.setHeader('Content-Type', 'text/event-stream'); emit('server.connected', {}); return; }
  if (route === '/api/agent') {
    const base = JSON.parse(require('node:fs').readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
    const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
    res.end(JSON.stringify({ data: [...Object.entries(inline.agent || {}).map(([id, agent]) => ({ id, system: agent.prompt })), ...Object.entries(base.agents || {}).map(([id, agent]) => ({ id, ...agent }))] })); return;
  }
  if (route === '/api/integration' || route === '/api/model') {
    activation ??= new Promise(resolve => setTimeout(() => { activated = true; resolve(); }, Number(process.env.ACTIVATION_DELAY_MS || 0)));
    if (route === '/api/integration') { await activation; res.end(JSON.stringify({ data: [] })); return; }
    if (process.env.FIRST_CATALOG_EMPTY && ++catalogReads === 1) { res.end(JSON.stringify({ data: [] })); return; }
    res.end(JSON.stringify({ data: activated
      ? [{ id: 'chat', providerID: 'deepseek', name: 'Chat', enabled: true, variants: (process.env.MODEL_VARIANTS || '').split(',').filter(Boolean).map(id => ({ id })), limit: { context: 1000 } }]
      : [{ id: 'builtin', providerID: 'opencode', name: 'Builtin', enabled: true, variants: [] }] })); return;
  }
  if (route === '/api/command') { res.end(JSON.stringify({ data: [{ name: 'review', description: 'Review' }] })); return; }
  if (route === '/api/skill') { res.end(JSON.stringify({ data: [{ id: 'writing', name: 'writing', path: '/skills/writing/SKILL.md', content: '' }, { id: 'writing.probe', name: 'writing.probe', path: '/skills/writing.probe/SKILL.md', content: '' }] })); return; }
  if (route === '/api/form') {
    const snapshot = [...ownedForms];
    if (settleInventory) {
      emit('form.cancelled', { sessionID: 'global', id: 'frm_mcp' }); mcpAnswer = 'cancelled'; interactions.emit('changed');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    res.end(JSON.stringify({ data: snapshot })); return;
  }
  if (route === '/api/session/global/form/frm_mcp/reply') { mcpAnswer = body.answer; interactions.emit('changed'); emit('form.replied', { sessionID: 'global', id: 'frm_mcp' }); res.writeHead(204).end(); return; }
  if (route === '/api/session/global/form/frm_mcp' && req.method === 'DELETE') { mcpAnswer = 'cancelled'; interactions.emit('changed'); emit('form.cancelled', { sessionID: 'global', id: 'frm_mcp' }); if (cancelRace) await new Promise(resolve => setTimeout(resolve, 30)); res.writeHead(204).end(); return; }
  if (route === '/api/mcp') { res.end(JSON.stringify({ data: [] })); return; }
  if (route === '/api/session' && process.env.EXPECT_RESUME === '1') { res.writeHead(409).end(); return; }
  if (route === '/api/session' || (route === '/api/session/ses_test' && req.method === 'GET')) { if (body.agent) selectedAgents.push(body.agent); res.end(JSON.stringify({ data: { id: 'ses_test' } })); return; }
  if (route.endsWith('/prompt') && body.delivery === 'steer') {
    if (process.env.STEER_ADMISSION === 'reject') { res.writeHead(400).end(); onSteer?.(null); return; }
    inbox.push(body.id);
    res.end(JSON.stringify({ data: { id: body.id, sessionID: 'ses_test', type: 'user', payload: { text: body.text }, delivery: 'steer' } }));
    emit('session.inbox.enqueued', { inboxID: body.id, item: { type: 'user', payload: { text: body.text }, delivery: 'steer' } });
    onSteer?.(body); return;
  }
  if (route.startsWith('/api/session/ses_test/inbox/') && req.method === 'DELETE') {
    const id = decodeURIComponent(route.slice('/api/session/ses_test/inbox/'.length));
    if (process.env.COMPACT_QUEUED_FILE && require('node:fs').existsSync(process.env.COMPACT_QUEUED_FILE) && require('node:fs').readFileSync(process.env.COMPACT_QUEUED_FILE, 'utf8') === id) {
      require('node:fs').unlinkSync(process.env.COMPACT_QUEUED_FILE); emit('session.inbox.cancelled', { inboxID: id }); res.writeHead(204).end(); return;
    }
    if (!inbox.includes(id)) { res.writeHead(409).end(JSON.stringify({ _tag: 'ConflictError' })); return; }
    inbox = inbox.filter(item => item !== id);
    emit('session.inbox.cancelled', { inboxID: id }); res.writeHead(204).end(); return;
  }
  if (route.endsWith('/interrupt')) { emit('session.execution.interrupted', { reason: 'user' }); res.end(JSON.stringify({ interrupted: true })); return; }
  if (route.endsWith('/model') && process.env.HOLD_SECOND_MODEL && ++modelRequests === 2) {
    require('node:fs').writeFileSync(process.env.HOLD_SECOND_MODEL, '');
    await new Promise(resolve => { releaseModel = resolve; setTimeout(resolve, 1000); });
  }
  if (route.endsWith('/model') || route.endsWith('/agent')) { if (body.model) selectedModels.push(body.model); if (body.agent) selectedAgents.push(body.agent); if (process.env.LATE_CHILD_STAGE === 'configuration') lateChild?.(); res.writeHead(204).end(); return; }
  if (route === '/api/session/ses_grand/permission/per_grand/reply') { grandApproval = body.decision; interactions.emit('changed'); res.writeHead(204).end(); return; }
  if (route.endsWith('/permission/per_test/reply')) { permission = body.decision; interactions.emit('changed'); res.writeHead(204).end(); return; }
  if (route.endsWith('/form/frm_test/reply')) { form = body.answer; interactions.emit('changed'); res.writeHead(204).end(); return; }
  // Paging as observed on v2.0.32: newest first by default, limit 1..200, order-bound cursors
  // that cannot be combined with order, and a next cursor on every non-empty page.
  if (route.endsWith('/message')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const limit = Number(query.get('limit') ?? 50), raw = query.get('cursor');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) { res.writeHead(400).end(JSON.stringify({ _tag: 'InvalidRequestError' })); return; }
    if (raw && query.has('order')) { res.writeHead(400).end(JSON.stringify({ _tag: 'InvalidCursorError', message: 'Cursor cannot be combined with order' })); return; }
    const cursor = raw ? JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) : null;
    const order = cursor ? cursor.order : query.get('order') || 'desc';
    const ordered = order === 'desc' ? [...messages].reverse() : messages;
    const start = cursor ? ordered.findIndex(message => message.id === cursor.id) + 1 : 0;
    const data = ordered.slice(start, start + limit);
    const encode = (id, direction) => Buffer.from(JSON.stringify({ id, order, direction })).toString('base64url');
    if (process.env.HOLD_HISTORY) {
      require('node:fs').writeFileSync(process.env.HOLD_HISTORY, '');
      // Publish the barrier before stream closure can trigger process shutdown.
      if (process.env.CLOSE_EVENTS_ON_HOLD === '1') feed?.end();
      while (require('node:fs').existsSync(process.env.HOLD_HISTORY)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    res.end(JSON.stringify({ data, cursor: { previous: data.length ? encode(data[0].id, 'previous') : null, next: data.length ? encode(data.at(-1).id, 'next') : null } })); return;
  }
  if (route.endsWith('/wait')) { if (idle) res.writeHead(204).end(); else waiter = res; return; }
  if (route === '/api/session/ses_test/compact') {
    if (req.method !== 'POST' || Object.keys(body).some(key => key !== 'id')) { res.writeHead(400).end(); return; }
    if (process.env.COMPACT_OUTCOME === 'http-error') { res.writeHead(400).end(JSON.stringify({ message: 'Cannot compact this session' })); return; }
    const compactId = body.id ?? 'msg_compact';
    if (process.env.COMPACT_QUEUED_FILE) {
      require('node:fs').writeFileSync(process.env.COMPACT_QUEUED_FILE, compactId);
      await new Promise(resolve => setTimeout(resolve, Number(process.env.COMPACT_ADMISSION_DELAY || 0)));
      res.end(JSON.stringify({ data: { id: compactId, type: 'compaction' } })); return;
    }
    idle = false;
    const compact = () => {
      emit('session.execution.started', {});
      if (process.env.STALE_COMPACT_FAILURE === '1') emit('session.compaction.failed', { reason: 'manual', inputID: 'msg_old_compaction', error: { type: 'compaction.interrupted', message: 'Compaction was interrupted' } });
      emit('session.inbox.delivered', { inboxID: compactId });
      emit('session.compaction.started', { reason: 'manual', inputID: compactId });
      if (process.env.COMPACT_STARTED_FILE) { require('node:fs').writeFileSync(process.env.COMPACT_STARTED_FILE, ''); return; }
      if (process.env.COMPACT_OUTCOME === 'failed') emit('session.compaction.failed', { reason: 'manual', inputID: compactId, error: { message: 'Compaction model failed' } });
      else emit('session.compaction.ended', { reason: 'manual', text: 'Internal summary' });
      // A failed compaction settles its barrier, so the surrounding drain can still succeed.
      emit('session.execution.succeeded', {}); idle = true;
    };
    if (process.env.COMPACT_BEFORE_RESPONSE === '1') compact();
    res.end(JSON.stringify({ data: { id: compactId, type: 'compaction' } }));
    if (process.env.COMPACT_BEFORE_RESPONSE !== '1') setTimeout(compact, 50);
    return;
  }
  if (route.endsWith('/prompt') || route.endsWith('/command')) {
    releaseModel?.();
    if (body.text.includes('Old local history')) { res.writeHead(400).end(); return; }
    const assistantMessageID = 'msg_assistant_' + (++turn), userMessage = { id: body.id ?? 'msg_user', type: 'user', time: { created: Date.now() } };
    // Steering scenarios need client admission before their first steer-triggering output.
    const eventsReleased = body.text.startsWith('steer')
      ? new Promise(resolve => promptEventReleases.set(body.id, resolve)) : Promise.resolve();
    idle = false; res.end(JSON.stringify({ data: { id: body.id ?? 'msg_user' } }));
    if (process.env.COMPACT_QUEUED_FILE && require('node:fs').existsSync(process.env.COMPACT_QUEUED_FILE)) {
      require('node:fs').unlinkSync(process.env.COMPACT_QUEUED_FILE);
      emit('session.compaction.ended', { reason: 'manual', text: 'Leaked compact' });
    }
    if (process.env.LATE_CHILD_STAGE === 'prompt') lateChild?.();
    // Ordinary scenarios allow either HTTP/SSE arrival order. Steering waits for the client barrier.
    setImmediate(async () => {
      await eventsReleased;
      emit('session.execution.started', {});
      // Undelivered steers left in the native inbox fold into the next execution.
      for (const inboxID of inbox.splice(0)) { emit('session.inbox.delivered', { inboxID }); emit('session.text.delta', { assistantMessageID, ordinal: 9, delta: 'Leaked steer ' }); }
      emit('session.step.started', { assistantMessageID });
      if (body.text.startsWith('steer')) {
        const deliver = steer => {
          inbox = inbox.filter(item => item !== steer.id);
          emit('session.inbox.delivered', { inboxID: steer.id });
          emit('session.step.started', { assistantMessageID: 'msg_steered' });
          emit('session.text.ended', { assistantMessageID: 'msg_steered', ordinal: 0, text: process.env.ECHO_PROMPT === '1' ? JSON.stringify(steer) : 'Saw ' + steer.text });
          emit('session.execution.succeeded', {});
        };
        onSteer = steer => {
          onSteer = undefined;
          if (!steer) { emit('session.text.ended', { assistantMessageID, ordinal: 0, text: 'Working alone' }); emit('session.execution.succeeded', {}); return; }
          if (body.text === 'steer') { emit('session.step.ended', {}); deliver(steer); }
          // The execution ended as the steer was admitted; native starts another execution for it.
          if (body.text === 'steer-late') { emit('session.execution.succeeded', {}); setTimeout(() => { emit('session.execution.started', {}); deliver(steer); }, 30); }
        };
        emit('session.text.delta', { assistantMessageID, ordinal: 0, delta: 'Working' });
        return;
      }
      if (process.env.ECHO_AGENTS === '1' || process.env.ECHO_MODELS === '1') {
        emit('session.text.ended', { assistantMessageID, ordinal: 0, text: JSON.stringify(process.env.ECHO_MODELS === '1' ? selectedModels.at(-1) : selectedAgents) });
        emit('session.execution.succeeded', {}); idle = true; waiter?.writeHead(204).end();
        return;
      }
      if (process.env.ECHO_PROMPT === '1') {
        // Native history is committed before idle; HTTP may arrive before the corresponding SSE events.
        messages = [{ id: assistantMessageID, type: 'assistant', content: [{ type: 'text', text: JSON.stringify({ route, body, ...(process.env.ECHO_CWD ? { cwd: process.cwd() } : {}) }) }] }];
        emit('session.text.ended', { assistantMessageID, ordinal: 0, text: JSON.stringify({ route, body, ...(process.env.ECHO_CWD ? { cwd: process.cwd() } : {}) }) });
        emit('session.execution.succeeded', {}); idle = true; waiter?.writeHead(204).end();
        return;
      }
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
        await waitForInteraction(() => mcpAnswer !== undefined);
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
        await waitForInteraction(() => grandApproval !== undefined);
        emit(grandApproval === 'once' ? 'session.execution.succeeded' : 'session.execution.failed', { error: { message: 'Nested approval was not answered' } });
        return;
      }
      if (body.text === 'cancel') { emit('session.text.delta', { assistantMessageID, ordinal: 0, delta: 'Waiting' }); return; }
      if (body.text === 'disconnect') { feed.end(); return; }
      if (body.text === 'proto-form') {
        emit('form.created', { form: { id: 'frm_test', sessionID: 'ses_test', title: 'Color', fields: [{ key: '__proto__', type: 'string', title: 'Pick a color', options: [{ value: 'Blue', label: 'Blue' }] }, { key: 'toString', type: 'number', title: 'Count' }] } });
        await waitForInteraction(() => form !== undefined);
        emit('session.text.ended', { assistantMessageID, ordinal: 0, text: JSON.stringify(form === undefined ? null : form) });
        emit('session.execution.succeeded', {}); idle = true;
        return;
      }
      emit('permission.asked', { id: 'per_test', action: 'shell', resources: ['echo test'] });
      if (body.text === 'question-wording') {
        emit('form.created', { form: { id: 'frm_test', sessionID: 'ses_test', title: 'Questions', metadata: { kind: 'question' }, fields: [{ key: 'q0', type: 'string', title: 'Color', description: 'Which color should the report use?', custom: true, options: [{ value: 'blue', label: 'Blue' }] }] } });
      }
      if (body.text !== 'slow' && body.text !== 'question-wording') emit('form.created', { form: { id: 'frm_test', sessionID: 'ses_test', title: 'Color', fields: [{ key: 'q0', type: 'string', title: 'Pick a color', options: [{ value: 'blue', label: 'Blue' }] }] } });
      await waitForInteraction(() => permission !== undefined && (form !== undefined || body.text === 'slow'));
      if (permission !== 'once' || (body.text !== 'slow' && form?.q0 !== 'blue')) { emit('session.execution.failed', { error: { message: 'Interactions not answered' } }); return; }
      if (body.text.startsWith('background')) {
        emit('session.tool.input.started', { assistantMessageID, id: 'tool_child', name: 'subagent' });
        emit('session.tool.called', { assistantMessageID, id: 'tool_child', input: { background: true, agent: 'worker' } });
        emit('session.tool.progress', { assistantMessageID, id: 'tool_child', metadata: { sessionID: 'ses_child', status: 'running' } });
        emit('session.tool.success', { assistantMessageID, id: 'tool_child', content: [{ type: 'text', text: 'Background child launched' }], metadata: { sessionID: 'ses_child', status: 'background' } });
        emit('session.tool.input.started', { sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'tool_read', name: 'read' });
        emit('session.tool.called', { sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'tool_read', input: { path: '/workspace/notes.md' } });
        emit('session.tool.success', { sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'tool_read', content: [{ type: 'text', text: 'Child read result' }] });
        emit('session.step.ended', { sessionID: 'ses_child', assistantMessageID: 'msg_child', tokens: { input: 900, output: 200, reasoning: 100, cache: { read: 300, write: 0 } } });
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
            await waitForInteraction(() => permission !== undefined && form !== undefined);
            if (permission !== 'once' || form?.q0 !== 'blue') return;
            if (body.text === 'background-nested') emit('session.execution.succeeded', { sessionID: 'ses_grand' });
          }
          emit('session.text.ended', { sessionID: 'ses_child', assistantMessageID: 'msg_child', ordinal: 0, text: 'Child result' });
          emit('session.execution.succeeded', { sessionID: 'ses_child' });
          emit('session.execution.started', {});
          emit('session.text.ended', { assistantMessageID: 'msg_background', ordinal: 0, text: 'Automatic reply' });
          // A stopped automatic reply stays open until the client interrupts it.
          if (body.text !== 'background-stop') emit('session.execution.succeeded', {});
        }, 50);
      }
      emit('session.tool.input.started', { assistantMessageID, id: 'reused_tool', name: 'read' });
      emit('session.tool.called', { assistantMessageID, id: 'reused_tool', input: { path: '/workspace/notes.md' } });
      emit('session.tool.success', { assistantMessageID, id: 'reused_tool', content: [{ type: 'text', text: 'Read result' }] });
      emit('session.text.delta', { assistantMessageID, ordinal: 0, delta: 'Finished ' });
      emit('session.text.ended', { assistantMessageID, ordinal: 0, text: 'Finished review' });
      emit('session.step.ended', { tokens: { input: 100, output: 30, reasoning: 5, cache: { read: 20, write: 10 } } });
      // Native history keeps earlier turns; each turn completes 1234ms after its user entry.
      messages.push(userMessage, { id: assistantMessageID, type: 'assistant', time: { created: userMessage.time.created + 1, completed: userMessage.time.created + 1234 }, finish: 'stop', tokens: { input: 100, output: 30, reasoning: 5, cache: { read: 20, write: 10 } }, content: [{ type: 'text', text: 'Finished review' }] });
      emit('session.execution.succeeded', {}); idle = true; waiter?.writeHead(204).end();
    }); return;
  }
  res.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port })));
process.stdin.resume(); process.stdin.on('end', () => server.close());
`;

/** Observe real prompt admission without replacing transport or kernel behavior. */
function releaseSteeringEventsOnAdmission(): void {
  const nativeRequest = OpencodeHTTPClient.prototype.request;
  const releases: Promise<void>[] = [];
  const failures: unknown[] = [];
  const observer = vi.spyOn(OpencodeHTTPClient.prototype, 'request').mockImplementation(function<T>(
    this: OpencodeHTTPClient, route: string, options: Parameters<OpencodeHTTPClient['request']>[1],
  ): Promise<T> {
    const admission = nativeRequest.bind(this)<T>(route, options);
    const body = options?.body;
    if (route.endsWith('/prompt') && isRecord(body) && !body.delivery && typeof body.text === 'string' && body.text.startsWith('steer')) {
      // Return the original promise to the kernel. Its synchronous admission continuation
      // runs before this separate HTTP round trip can release any SSE output.
      releases.push(admission.then(() => nativeRequest.call(this, '/fixture/release-prompt-events', {
        method: 'POST', body: { id: body.id },
      })).then(() => undefined, error => { failures.push(error); }));
    }
    return admission;
  });
  onTestFinished(async () => {
    observer.mockRestore();
    await Promise.all(releases);
    expect(failures).toEqual([]);
  });
}

async function createFixture(resume = false, approval?: (signal: AbortSignal) => Promise<void>, environmentVariables = '', resolveAnswers?: (questions: unknown) => AskUserAnswers) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-http-execution-')));
  const cliPath = path.join(root, 'opencode.cjs');
  writeFileSync(cliPath, fixture, { mode: 0o700 });
  const hostFixture = await createProviderHostFixture({
    settings: { model: 'opencode:deepseek/chat', providerConfigs: { opencode: { enabled: true, visibleModels: ['deepseek/chat'], discoveredModels: [{ rawId: 'deepseek/chat', label: 'DeepSeek' }], environmentVariables: [`XDG_DATA_HOME=${path.join(root, 'data')}`, resume ? 'EXPECT_RESUME=1' : '', environmentVariables].join('\n') } } },
    overrides: { workingDirectory: root, getResolvedProviderCliPath: async () => cliPath },
  });
  const plugin = hostFixture.host;
  const approvals: unknown[] = [], questions: unknown[] = [];
  const serverService = new OpencodeServerService();
  const session = new OpencodeExecutionBackend(plugin.getRuntimeHost('opencode'), { serverService }).createSession({
    ...(resume ? { resumeSeed: { providerSessionId: 'ses_test' } } : {}),
    workingDirectory: root, lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported',
    interactionPort: {
      requestApproval: async (request, signal) => { approvals.push(request); await approval?.(signal); return { interactionId: request.interactionId, decision: 'allow' }; },
      askUserQuestion: async request => { questions.push(request); const questionsInput = request.input.questions; return { interactionId: request.interactionId, answers: resolveAnswers ? resolveAnswers(questionsInput) : { q0: Array.isArray(questionsInput) ? questionsInput[0].options[0].value : '' } }; },
      dismissInteraction() {},
    },
  });
  return { root, plugin, settings: hostFixture.settings, session, approvals, questions, async dispose() { await session.dispose(); await serverService.dispose(); await hostFixture.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

function request(text = '/review changes'): ProviderExecutionRequest {
  return {
    input: [{ type: 'text', text }],
    configuration: { model: 'opencode:deepseek/chat', permissionMode: 'normal', systemInstructions: { kind: 'explicit', instructions: 'Review changes.' } },
    toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal,
  };
}

const writingSkill = { skills: [{ id: 'writing', mention: { start: 0, end: 8, text: '/writing' } }] };

export { createFixture, fixture, NATIVE_STARTUP_TIMEOUT_MS, releaseSteeringEventsOnAdmission, request, writingSkill };
