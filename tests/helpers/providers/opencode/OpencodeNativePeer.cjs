#!/usr/bin/env node
// @ts-check
// One native OpenCode v2 HTTP boundary. Test scenarios supply data and faults;
// authentication, SSE framing, readiness and the stdin process lease have one owner.
const fs = require('node:fs');
const path = require('node:path');
const { setInterval, clearInterval } = require('node:timers');
const { EventEmitter, once } = require('node:events');

/** @typedef {Record<string, any>} WireObject Native JSON, including deliberately malformed scenario input. */
/** @typedef {{id: string, type: string} & WireObject} NativeMessage */
/** @typedef {{model?: {providerID: string, id: string}, messages: NativeMessage[]}} HistorySession */
/**
 * @typedef {object} OpencodePeerOptions
 * @property {'execution'|'workspace'|'metadata'|'history'|'retention'} scenario
 * @property {string} [version] Version-report override only; serve always models v2.
 * @property {string} [expectedDatabase] Refuse a launch against any other database.
 * @property {string} [logFile] JSONL launch/request observations.
 * @property {number} [pageSize] Maximum history page size.
 * @property {'sessions'|'checkpoint'} [historyFormat] Database JSON shape.
 * @property {boolean} [failFork] Refuse native fork requests.
 * @property {string} [forkId] Explicit child ID for scenarios asserting native identity.
 */
/** @typedef {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, body: WireObject, route: string) => Promise<unknown>} Handler */
/** @typedef {{handle: Handler, beforeSubscribe?: (res: import('node:http').ServerResponse) => Promise<void>, afterSubscribe?: () => void, ready?: (url: string) => Promise<void>, close?: () => void}} Scenario */
/** @typedef {{options: OpencodePeerOptions, feeds: Set<import('node:http').ServerResponse>, forms: Map<string, WireObject>, emit: (type: string, data?: WireObject) => void, disconnect: () => void}} PeerContext */
/** @type {Record<string, string>} */
const env = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;

/** @returns {WireObject} */
function readConfig() {
  const base = env.OPENCODE_CONFIG ? JSON.parse(fs.readFileSync(env.OPENCODE_CONFIG, 'utf8')) : {};
  const inline = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}');
  return { ...base, ...inline, plugins: [...(base.plugins || []), ...(inline.plugins || [])],
    agent: { ...base.agent, ...inline.agent }, agents: { ...base.agents, ...inline.agents } };
}
/** @returns {WireObject[]} */
function readAgents() {
  const config = readConfig();
  /** @type {WireObject[]} */
  const agents = Object.entries(config.agent || {}).map(([id, agent]) => ({ id, system: agent.prompt }))
    .concat(Object.entries(config.agents || {}).map(([id, agent]) => ({ id, ...agent })))
;
  return agents.filter(agent => !agent.disabled && !config.agents?.[agent.id]?.disabled);
}

/**
 * OpenCode v2 cursors carry ordering and cannot be combined with a new order.
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {NativeMessage[]} messages
 * @param {number} [maximumPageSize]
 */
function replyHistoryPage(res, url, messages, maximumPageSize = 200) {
  const query = url.searchParams;
  const requested = Number(query.get('limit') ?? 50), raw = query.get('cursor');
  if (!Number.isInteger(requested) || requested < 1 || requested > 200) { res.writeHead(400).end(JSON.stringify({ _tag: 'InvalidRequestError' })); return; }
  if (raw && query.has('order')) { res.writeHead(400).end(JSON.stringify({ _tag: 'InvalidCursorError', message: 'Cursor cannot be combined with order' })); return; }
  const cursor = raw ? JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) : null;
  const order = cursor ? cursor.order : query.get('order') || 'desc';
  const ordered = order === 'desc' ? [...messages].reverse() : messages;
  const start = cursor ? ordered.findIndex(message => message.id === cursor.id) + 1 : 0;
  const data = ordered.slice(start, start + Math.min(requested, maximumPageSize));
  /** @param {string} id @param {string} direction */
  const encode = (id, direction) => Buffer.from(JSON.stringify({ id, order, direction })).toString('base64url');
  res.end(JSON.stringify({ data, cursor: {
    previous: data.length ? encode(data[0].id, 'previous') : null,
    next: data.length ? encode(data[data.length - 1].id, 'next') : null,
  } }));
}

/** @param {OpencodePeerOptions} options */
function startNativePeer(options) {
  if (process.argv.includes('--version')) {
    const ready = () => {
      if (env.PROCESS_LOG) fs.appendFileSync(env.PROCESS_LOG + '.version-count', 'x');
      process.stdout.write((options.version || '2.0.14') + '\n');
    };
    if (env.PROCESS_LOG && fs.existsSync(env.PROCESS_LOG + '.version-hold')) {
      fs.writeFileSync(env.PROCESS_LOG + '.version-started', '');
      const wait = setInterval(() => { if (!fs.existsSync(env.PROCESS_LOG + '.version-hold')) { clearInterval(wait); ready(); } }, 10);
    } else ready();
    return;
  }
  if (!process.argv.includes('serve')) process.exit(3);
  if (options.expectedDatabase && env.OPENCODE_DB !== options.expectedDatabase) process.exit(3);
  if (options.scenario === 'metadata' && (!process.argv.includes('--stdio') || env.OPENCODE_DB !== env.EXPECTED_DATABASE)) process.exit(2);
  if (env.PROCESS_LOG) fs.appendFileSync(env.PROCESS_LOG, JSON.stringify({ pid: process.pid, db: env.OPENCODE_DB, generation: env.GENERATION }) + '\n');
  if (options.logFile) fs.appendFileSync(options.logFile, JSON.stringify({ launch: process.pid, path: env.PATH }) + '\n');
  /** @type {Set<import('node:http').ServerResponse>} */
  const feeds = new Set();
  /** @type {Map<string, WireObject>} */
  const forms = new Map();
  /** @type {PeerContext} */
  const context = { options, feeds, forms,
    emit(type, data = {}) {
      if (type === 'form.created') forms.set(data.form.id, data.form);
      if (type === 'form.cancelled' || type === 'form.replied') forms.delete(data.id);
      for (const feed of feeds) feed.write('data: ' + JSON.stringify({ type, data }) + '\n\n');
    },
    disconnect() { for (const feed of feeds) feed.end(); },
  };
  /** @type {Scenario} */
  const scenario = options.scenario === 'execution' ? executionScenario(context)
    : options.scenario === 'workspace' ? workspaceScenario(context)
    : options.scenario === 'metadata' ? metadataScenario(context)
    : options.scenario === 'history' ? historyScenario(context)
    : { handle: async (_req, res) => { res.writeHead(404).end(); } };
  const http = require('node:http');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname;
    if (options.logFile) fs.appendFileSync(options.logFile, JSON.stringify({ method: req.method, route }) + '\n');
    if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + env.OPENCODE_PASSWORD).toString('base64')) { res.writeHead(403).end(); return; }
    if (options.scenario === 'metadata' && url.searchParams.get('location[directory]') !== process.cwd()) { res.writeHead(403).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader('Content-Type', 'application/json');
    if (route === '/api/event') {
      await scenario.beforeSubscribe?.(res);
      if (res.destroyed) return;
      res.setHeader('Content-Type', 'text/event-stream');
      feeds.add(res); res.on('close', () => feeds.delete(res));
      res.write('data: ' + JSON.stringify({ type: 'server.connected', data: {} }) + '\n\n');
      scenario.afterSubscribe?.();
      return;
    }
    if (route === '/fixture/pid' || route === '/api/info') { res.end(JSON.stringify({ data: { pid: process.pid } })); return; }
    await scenario.handle(req, res, url, body, route);
  });
  server.listen(0, '127.0.0.1', async () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Peer did not bind TCP');
    const url = 'http://127.0.0.1:' + address.port;
    if (scenario.ready) await scenario.ready(url);
    else process.stdout.write(JSON.stringify({ url }) + '\n');
  });
  process.stdin.resume();
  process.stdin.on('end', () => { scenario.close?.(); context.disconnect(); server.close(); });
}

/** @param {PeerContext} context @returns {Scenario} */
function executionScenario(context) {
const interactions = new EventEmitter();
/** @type {Map<string, () => void>} */
const promptEventReleases = new Map();
// Replies synchronize the fixture; this deadline only bounds a missing reply after a regression.
/** @param {() => boolean} predicate */
const waitForInteraction = async predicate => {
  const signal = AbortSignal.timeout(30_000);
  while (!predicate()) await once(interactions, 'changed', { signal });
};
// Like the native server, create the database it was launched with.
if (env.OPENCODE_DB && env.OPENCODE_DB !== ':memory:' && !fs.existsSync(env.OPENCODE_DB)) {
  fs.mkdirSync(path.dirname(env.OPENCODE_DB), { recursive: true });
  fs.writeFileSync(env.OPENCODE_DB, '');
}
/** @type {((steer: WireObject | null) => void) | undefined} */
let onSteer;
/** @type {string[]} */
const selectedAgents = [];
/** @type {WireObject[]} */
const selectedModels = [];
/** @type {string[]} */
let inbox = [];
/** @type {(() => void) | undefined} */
let lateChild;
/** @type {string | undefined} */
let permission;
/** @type {string | undefined} */
let grandApproval;
/** @type {WireObject | undefined} */
let form;
const readForm = () => form;
/** @type {unknown} */
let mcpAnswer;
/** @type {WireObject[]} */
let ownedForms = [];
/** @type {import('node:http').ServerResponse | undefined} */
let waiter;
/** @type {NativeMessage[]} */
let messages = [];
/** @type {(() => void) | undefined} */
let releaseModel;
let settleInventory = false, cancelRace = false, idle = true, turn = 0, modelRequests = 0, catalogReads = 0;
let activated = !env.ACTIVATION_DELAY_MS;
/** @type {Promise<void> | undefined} */
let activation;
// Earlier native turns, created before any prompt of this test.
for (let index = 0; index < Number(env.SEED_HISTORY || 0); index += 1) messages.push({ id: 'msg_old_' + String(index).padStart(5, '0'), type: index % 2 ? 'assistant' : 'user', time: { created: Date.now() - 60000 + index } });
/** @param {string} type @param {WireObject} data */
const emit = (type, data) => {
  const send = () => context.emit(type, { sessionID: 'ses_test', ...data });
  if (env.ECHO_EVENT_DELAY_MS && type.startsWith('session.')) setTimeout(send, Number(env.ECHO_EVENT_DELAY_MS));
  else send();
};

/** @type {Handler} */
const handle = async (req, res, url, body, route) => {
  if (env.REQUEST_LOG) fs.appendFileSync(env.REQUEST_LOG, req.method + ' ' + req.url + '\n');
  if (route === '/fixture/release-prompt-events') {
    const release = promptEventReleases.get(body.id);
    if (!release) { res.writeHead(409).end(); return; }
    promptEventReleases.delete(body.id); release(); res.writeHead(204).end(); return;
  }
  if (route === '/api/agent') { res.end(JSON.stringify({ data: readAgents() })); return; }
  if (route === '/api/integration' || route === '/api/model') {
    activation ??= new Promise(resolve => setTimeout(() => { activated = true; resolve(); }, Number(env.ACTIVATION_DELAY_MS || 0)));
    if (route === '/api/integration') { await activation; res.end(JSON.stringify({ data: [] })); return; }
    if (env.FIRST_CATALOG_EMPTY && ++catalogReads === 1) { res.end(JSON.stringify({ data: [] })); return; }
    res.end(JSON.stringify({ data: activated
      ? [{ id: 'chat', providerID: 'deepseek', name: 'Chat', enabled: true, variants: (env.MODEL_VARIANTS || '').split(',').filter(Boolean).map(id => ({ id })), limit: { context: 1000 } }]
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
  if (route === '/api/session' && env.EXPECT_RESUME === '1') { res.writeHead(409).end(); return; }
  if (route === '/api/session' || (route === '/api/session/ses_test' && req.method === 'GET')) { if (body.agent) selectedAgents.push(body.agent); res.end(JSON.stringify({ data: { id: 'ses_test' } })); return; }
  if (route.endsWith('/prompt') && body.delivery === 'steer') {
    if (env.STEER_ADMISSION === 'reject') { res.writeHead(400).end(); onSteer?.(null); return; }
    inbox.push(body.id);
    res.end(JSON.stringify({ data: { id: body.id, sessionID: 'ses_test', type: 'user', payload: { text: body.text }, delivery: 'steer' } }));
    emit('session.inbox.enqueued', { inboxID: body.id, item: { type: 'user', payload: { text: body.text }, delivery: 'steer' } });
    onSteer?.(body); return;
  }
  if (route.startsWith('/api/session/ses_test/inbox/') && req.method === 'DELETE') {
    const id = decodeURIComponent(route.slice('/api/session/ses_test/inbox/'.length));
    if (env.COMPACT_QUEUED_FILE && fs.existsSync(env.COMPACT_QUEUED_FILE) && fs.readFileSync(env.COMPACT_QUEUED_FILE, 'utf8') === id) {
      fs.unlinkSync(env.COMPACT_QUEUED_FILE); emit('session.inbox.cancelled', { inboxID: id }); res.writeHead(204).end(); return;
    }
    if (!inbox.includes(id)) { res.writeHead(409).end(JSON.stringify({ _tag: 'ConflictError' })); return; }
    inbox = inbox.filter(item => item !== id);
    emit('session.inbox.cancelled', { inboxID: id }); res.writeHead(204).end(); return;
  }
  if (route.endsWith('/interrupt')) { emit('session.execution.interrupted', { reason: 'user' }); res.end(JSON.stringify({ interrupted: true })); return; }
  if (route.endsWith('/model') && env.HOLD_SECOND_MODEL && ++modelRequests === 2) {
    fs.writeFileSync(env.HOLD_SECOND_MODEL, '');
    await new Promise(resolve => { releaseModel = () => resolve(undefined); setTimeout(resolve, 1000); });
  }
  if (route.endsWith('/model') || route.endsWith('/agent')) { if (body.model) selectedModels.push(body.model); if (body.agent) selectedAgents.push(body.agent); if (env.LATE_CHILD_STAGE === 'configuration') lateChild?.(); res.writeHead(204).end(); return; }
  if (route === '/api/session/ses_grand/permission/per_grand/reply') { grandApproval = body.decision; interactions.emit('changed'); res.writeHead(204).end(); return; }
  if (route.endsWith('/permission/per_test/reply')) { permission = body.decision; interactions.emit('changed'); res.writeHead(204).end(); return; }
  if (route.endsWith('/form/frm_test/reply')) { form = body.answer; interactions.emit('changed'); res.writeHead(204).end(); return; }
  // Paging as observed on v2.0.32: newest first by default, limit 1..200, order-bound cursors
  // that cannot be combined with order, and a next cursor on every non-empty page.
  if (route.endsWith('/message')) {
    if (env.HOLD_HISTORY) {
      fs.writeFileSync(env.HOLD_HISTORY, '');
      // Publish the barrier before stream closure can trigger process shutdown.
      if (env.CLOSE_EVENTS_ON_HOLD === '1') context.disconnect();
      while (fs.existsSync(env.HOLD_HISTORY)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    replyHistoryPage(res, url, messages); return;
  }
  if (route.endsWith('/wait')) { if (idle) res.writeHead(204).end(); else waiter = res; return; }
  if (route === '/api/session/ses_test/compact') {
    if (req.method !== 'POST' || Object.keys(body).some(key => key !== 'id')) { res.writeHead(400).end(); return; }
    if (env.COMPACT_OUTCOME === 'http-error') { res.writeHead(400).end(JSON.stringify({ message: 'Cannot compact this session' })); return; }
    const compactId = body.id ?? 'msg_compact';
    if (env.COMPACT_QUEUED_FILE) {
      fs.writeFileSync(env.COMPACT_QUEUED_FILE, compactId);
      await new Promise(resolve => setTimeout(resolve, Number(env.COMPACT_ADMISSION_DELAY || 0)));
      res.end(JSON.stringify({ data: { id: compactId, type: 'compaction' } })); return;
    }
    idle = false;
    const compact = () => {
      emit('session.execution.started', {});
      if (env.STALE_COMPACT_FAILURE === '1') emit('session.compaction.failed', { reason: 'manual', inputID: 'msg_old_compaction', error: { type: 'compaction.interrupted', message: 'Compaction was interrupted' } });
      emit('session.inbox.delivered', { inboxID: compactId });
      emit('session.compaction.started', { reason: 'manual', inputID: compactId });
      if (env.COMPACT_STARTED_FILE) { fs.writeFileSync(env.COMPACT_STARTED_FILE, ''); return; }
      if (env.COMPACT_OUTCOME === 'failed') emit('session.compaction.failed', { reason: 'manual', inputID: compactId, error: { message: 'Compaction model failed' } });
      else emit('session.compaction.ended', { reason: 'manual', text: 'Internal summary' });
      // A failed compaction settles its barrier, so the surrounding drain can still succeed.
      emit('session.execution.succeeded', {}); idle = true;
    };
    if (env.COMPACT_BEFORE_RESPONSE === '1') compact();
    res.end(JSON.stringify({ data: { id: compactId, type: 'compaction' } }));
    if (env.COMPACT_BEFORE_RESPONSE !== '1') setTimeout(compact, 50);
    return;
  }
  if (route.endsWith('/prompt') || route.endsWith('/command')) {
    releaseModel?.();
    if (body.text.includes('Old local history')) { res.writeHead(400).end(); return; }
    const assistantMessageID = 'msg_assistant_' + (++turn), userMessage = { id: body.id ?? 'msg_user', type: 'user', time: { created: Date.now() } };
    // Steering scenarios need client admission before their first steer-triggering output.
    const eventsReleased = body.text.startsWith('steer')
      ? new Promise(resolve => promptEventReleases.set(body.id, () => resolve(undefined))) : Promise.resolve();
    idle = false; res.end(JSON.stringify({ data: { id: body.id ?? 'msg_user' } }));
    if (env.COMPACT_QUEUED_FILE && fs.existsSync(env.COMPACT_QUEUED_FILE)) {
      fs.unlinkSync(env.COMPACT_QUEUED_FILE);
      emit('session.compaction.ended', { reason: 'manual', text: 'Leaked compact' });
    }
    if (env.LATE_CHILD_STAGE === 'prompt') lateChild?.();
    // Ordinary scenarios allow either HTTP/SSE arrival order. Steering waits for the client barrier.
    setImmediate(async () => {
      await eventsReleased;
      emit('session.execution.started', {});
      // Undelivered steers left in the native inbox fold into the next execution.
      for (const inboxID of inbox.splice(0)) { emit('session.inbox.delivered', { inboxID }); emit('session.text.delta', { assistantMessageID, ordinal: 9, delta: 'Leaked steer ' }); }
      emit('session.step.started', { assistantMessageID });
      if (body.text.startsWith('steer')) {
        /** @param {WireObject} steer */
        const deliver = steer => {
          inbox = inbox.filter(item => item !== steer.id);
          emit('session.inbox.delivered', { inboxID: steer.id });
          emit('session.step.started', { assistantMessageID: 'msg_steered' });
          emit('session.text.ended', { assistantMessageID: 'msg_steered', ordinal: 0, text: env.ECHO_PROMPT === '1' ? JSON.stringify(steer) : 'Saw ' + steer.text });
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
      if (env.ECHO_AGENTS === '1' || env.ECHO_MODELS === '1') {
        emit('session.text.ended', { assistantMessageID, ordinal: 0, text: JSON.stringify(env.ECHO_MODELS === '1' ? selectedModels.at(-1) : selectedAgents) });
        emit('session.execution.succeeded', {}); idle = true; waiter?.writeHead(204).end();
        return;
      }
      if (env.ECHO_PROMPT === '1') {
        // Native history is committed before idle; HTTP may arrive before the corresponding SSE events.
        messages = [{ id: assistantMessageID, type: 'assistant', content: [{ type: 'text', text: JSON.stringify({ route, body, ...(env.ECHO_CWD ? { cwd: process.cwd() } : {}) }) }] }];
        emit('session.text.ended', { assistantMessageID, ordinal: 0, text: JSON.stringify({ route, body, ...(env.ECHO_CWD ? { cwd: process.cwd() } : {}) }) });
        emit('session.execution.succeeded', {}); idle = true; waiter?.writeHead(204).end();
        return;
      }
      if (body.text.startsWith('mcp-form')) {
        /** @type {{id: string, sessionID: string, title: string, metadata: WireObject, fields: Array<{key: string, type: string, title: string, options: Array<{value: string, label: string}>, custom: boolean, required: boolean, default?: string, maxLength?: number}>}} */
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
      if (body.text === 'disconnect') { context.disconnect(); return; }
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
      if (permission !== 'once' || (body.text !== 'slow' && readForm()?.q0 !== 'blue')) { emit('session.execution.failed', { error: { message: 'Interactions not answered' } }); return; }
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
            if (permission !== 'once' || readForm()?.q0 !== 'blue') return;
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
};
return { handle };
}

/** @param {PeerContext} context @returns {Scenario} */
function workspaceScenario(context) {
const forms = context.forms, feeds = context.feeds, emit = context.emit;
let sequence = 0, commandReads = 0;
/** @type {Array<() => void> | null} */
let heldCommands = null;
const store = env.OPENCODE_DB + '.sessions.json';
const saved = env.OPENCODE_DB !== ':memory:' && fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {sessions:[],deleted:[],sequence:0};
/** @type {Map<string, WireObject>} */
const sessions = new Map(saved.sessions);
/** @type {string[]} */
const deleted = saved.deleted;
sequence = saved.sequence;
/** @type {Array<() => void> | null} */
let held = null;
// Native HTTP responses may fail or remain pending independently of SSE delivery.
/** @type {Map<string, {status: number, body: unknown}>} */
const routeErrors = new Map();
/** @type {Map<string, {pending: Array<() => void>, arrivals: Array<() => void>}>} */
const heldRoutes = new Map();
const save = () => { if (env.OPENCODE_DB !== ':memory:') fs.writeFileSync(store, JSON.stringify({sessions:[...sessions],deleted,sequence})); };
const config = readConfig, agents = readAgents;

/** @type {Handler} */
const handle = async (req, res, url, body, route) => {
 const parts = route.split('/'), id = parts[3];
 /** @param {unknown} data */
 const reply = data => res.end(JSON.stringify({data}));
 if (route === '/fixture/route-error') {
   if (body.status) routeErrors.set(body.route, { status: body.status, body: body.error });
   else routeErrors.delete(body.route);
   res.writeHead(204).end(); return;
 }
 if (route === '/fixture/hold-route') {
   heldRoutes.set(body.route, { pending: [], arrivals: [] }); res.writeHead(204).end(); return;
 }
 if (route === '/fixture/wait-route') {
   const held = heldRoutes.get(url.searchParams.get('route') || '');
   if (!held) { res.writeHead(409).end('Route is not held'); return; }
   const arrived = () => reply({ count: held.pending.length });
   if (held.pending.length) arrived(); else held.arrivals.push(arrived);
   return;
 }
 if (route === '/fixture/release-route') {
   const held = heldRoutes.get(body.route);
   heldRoutes.delete(body.route);
   for (const release of held?.pending || []) release();
   res.writeHead(204).end(); return;
 }
 const heldRoute = heldRoutes.get(route);
 if (heldRoute) await new Promise(resolve => {
   heldRoute.pending.push(() => resolve(undefined));
   for (const arrived of heldRoute.arrivals.splice(0)) arrived();
 });
 const fault = routeErrors.get(route);
 if (fault) { res.writeHead(fault.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(fault.body)); return; }
 if (route === '/fixture/config') return reply({ config:config(), path:env.OPENCODE_CONFIG, url:env.CLAUDIAN_SESSION_TOOLS_URL, routeId:env.CLAUDIAN_SESSION_TOOLS_ROUTE_ID });
 if (route === '/fixture/session-tool') {
   const entry = config().plugins?.find(/** @param {WireObject} p */ p => p.package?.includes('/session-tools'));
   if (!entry) return reply({isError:true,text:'missing plugin'});
   const plugin = await import(entry.package + '/index.js');
   /** @typedef {{name: string, options: unknown, execute: (args: WireObject, context: {sessionID: string, signal: AbortSignal}) => Promise<unknown>}} NativeTool */
   /** @type {NativeTool[]} */
   const tools = [];
   const controller = new AbortController();
   if (body.aborted) controller.abort();
   await plugin.default.setup({tool:{transform:async (/** @type {(tools: {add: (tool: NativeTool) => void}) => Promise<void>} */ f)=>f({add:d=>tools.push(d)})}});
   try { return reply({specs:tools.map(t=>({name:t.name,options:t.options})), result:await tools.find(t=>t.name===body.tool)?.execute(body.args,{sessionID:body.sessionID,signal:controller.signal})}); }
   catch(error) { return reply({isError:true,text:error instanceof Error ? error.message : String(error)}); }
 }
 if (route === '/fixture/event') { emit(body.type, body.data); res.writeHead(204).end(); return; }
 if (route === '/fixture/disconnect') { for(const f of feeds) f.end(); res.writeHead(204).end(); return; }
 if (route === '/api/session/global/form/form_owned' && req.method==='DELETE') { emit('form.cancelled',{sessionID:'global',id:'form_owned'}); res.writeHead(204).end(); return; }
 // Saved provider credentials live in the native database.
 if (route === '/api/model') return reply(env.OPENCODE_DB === ':memory:' ? [{ id:'free', providerID:'opencode', name:'Free', enabled:true, variants:[] }] : [{ id:'chat', providerID:'local', name:env.GENERATION || 'Chat ' + path.basename(env.OPENCODE_DB), enabled:true, variants:[] }]);
 if (route === '/api/form') return reply([...forms.values()]);
 if (route.startsWith('/api/experimental/session/') && route.endsWith('/wait')) return setTimeout(() => { res.writeHead(204).end(); }, 50);
 if (route === '/api/info') return reply({pid:process.pid});
 if (route === '/fixture/command-reads') return reply(commandReads);
 if (route === '/fixture/hold-commands') { heldCommands = []; res.writeHead(204).end(); return; }
 if (route === '/fixture/release-commands') { const pending = heldCommands ?? []; heldCommands = null; for (const send of pending) send(); res.writeHead(204).end(); return; }
 if (route === '/api/command') { commandReads++; const send = () => reply(fs.existsSync(env.PROCESS_LOG + '.commands') ? JSON.parse(fs.readFileSync(env.PROCESS_LOG + '.commands','utf8')) : [{ name: 'init' }]); if (heldCommands) heldCommands.push(send); else send(); return; }
 if (route === '/api/agent') return reply(agents());
 if (route === '/fixture/sessions') return reply({ ids:[...sessions.keys()], held:held?.length ?? 0, deleted });
 if (route === '/fixture/system') return reply({ sessions:Object.fromEntries([...sessions].map(([id,s]) => [id, agents().find(a => a.id === s.agent)?.system ?? null])), agents:agents().map(a => a.id) });
 if (route === '/fixture/hold-sessions') { held = []; res.writeHead(204).end(); return; }
 if (route === '/fixture/release-sessions') { const pending = held ?? []; held = null; for (const send of pending) send(); res.writeHead(204).end(); return; }
 if (route === '/api/session') { const id = 'ses_' + (++sequence); const session = {id, agent:body.agent}; sessions.set(id,session); save(); if (held) { held.push(() => reply(session)); return; } return reply(session); }
 const session = sessions.get(id);
 if (!session) { res.writeHead(404).end(); return; }
 if (parts.length === 4 && req.method === 'DELETE') { sessions.delete(id); deleted.push(id); save(); res.writeHead(204).end(); return; }
 if (parts.length === 4) return reply(session);
 // A native fork copies the source's stored context into an independent child.
 if (parts[4] === 'fork') { const child={...session,id:'ses_'+(++sequence),context:[...(session.context||[])]}; sessions.set(child.id,child); save(); if (held) { held.push(() => reply(child)); return; } return reply(child); }
 if (parts[4] === 'message') { replyHistoryPage(res, url, [{id:'msg_source',type:'assistant',content:[{type:'text',text:'Source reply'}]}]); return; }
 if (parts[4] === 'agent') { session.agent=body.agent; res.writeHead(204).end(); return; }
 if (parts[4] === 'model') { session.model=body.model; save(); res.writeHead(204).end(); return; }
 if (parts[4] === 'interrupt') { emit('session.execution.interrupted',{sessionID:id}); res.writeHead(204).end(); return; }
 if (parts[4] === 'prompt' || parts[4] === 'command') {
  if (parts[4] === 'prompt') {
   // Record the native context each prompt sees before the turn joins it.
   const context = session.context = session.context || [];
   fs.appendFileSync(env.PROCESS_LOG + '.prompts', JSON.stringify({sessionID:id,context:[...context],text:body.text}) + '\n');
   context.push(body.text, 'Reply to ' + body.text); save();
  }
  reply({id:'msg_user'});
  setImmediate(()=>{
   emit('session.execution.started',{sessionID:id});
   emit('session.text.delta',{sessionID:id,assistantMessageID:'msg_'+id,ordinal:0,delta:parts[4] === 'command' ? 'Command: ' + body.name : body.text});
   if(body.text !== 'hold') emit('session.execution.succeeded',{sessionID:id});
  }); return;
 }
 res.writeHead(404).end();
};
return { handle };
}

/** @param {PeerContext} context @returns {Scenario} */
function metadataScenario(context) {
  let reads = 0, commandReads = 0, skillReads = 0;
  /** @param {string} type */
  const emit = type => context.emit(type, {});
  if (!env.NO_CATALOG_EVENTS) fs.watchFile(env.CATALOG_FILE, { interval: 20 }, () => emit('model.updated'));
  if (!env.NO_CATALOG_EVENTS) fs.watchFile(env.CATALOG_FILE + '.providers', { interval: 20 }, () => emit('provider.updated'));
  if (!env.NO_CATALOG_EVENTS) fs.watchFile(env.CATALOG_FILE + '.commands', { interval: 20 }, () => emit('command.updated'));
  if (!env.NO_CATALOG_EVENTS) fs.watchFile(env.CATALOG_FILE + '.skills', { interval: 20 }, () => emit('skill.updated'));
  /** @param {string} suffix */
  const waitForRelease = async suffix => {
    while (fs.existsSync(env.CATALOG_FILE + suffix)) await new Promise(resolve => setTimeout(resolve, 10).unref());
  };
  let activated = !env.ACTIVATION_DELAY_MS && !fs.existsSync(env.CATALOG_FILE + '.activation-hold'), activation;

/** @type {Handler} */
const handle = async (req, res, url) => {
    if (req.method !== 'GET' || !['/api/model', '/api/command', '/api/skill', '/api/integration', '/api/provider'].includes(url.pathname)) {
      res.writeHead(405); res.end(); return;
    }
    // Provider display names are optional: without a providers file the endpoint is absent, as in older versions.
    if (url.pathname === '/api/provider') {
      if (!fs.existsSync(env.CATALOG_FILE + '.providers')) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ location: { directory: process.cwd() }, data: JSON.parse(fs.readFileSync(env.CATALOG_FILE + '.providers', 'utf8')) }));
      return;
    }
    activation ??= (async () => {
      await waitForRelease('.activation-hold');
      if (env.ACTIVATION_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(env.ACTIVATION_DELAY_MS)));
      activated = true;
    })();
    if (url.pathname === '/api/integration') {
      fs.writeFileSync(env.ENDPOINT_FILE + '.integration', '');
      if (env.INTEGRATION_STATUS === 'hang') {
        res.on('close', () => fs.writeFileSync(env.ENDPOINT_FILE + '.integration-aborted', ''));
        return;
      }
      if (env.INTEGRATION_STATUS) { res.writeHead(Number(env.INTEGRATION_STATUS)).end(); return; }
      await activation;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [] })); return;
    }
    if (fs.existsSync(env.CATALOG_FILE + '.invalid')) {
      res.setHeader('Content-Type', 'application/json');
      res.end('{}'); return;
    }
    if (url.pathname === '/api/command') {
      fs.writeFileSync(env.ENDPOINT_FILE + '.command-read', '');
      if (fs.existsSync(env.CATALOG_FILE + '.command-error')) {
        res.writeHead(500).end('Command catalog unavailable'); return;
      }
    }
    if (url.pathname === '/api/model' && fs.existsSync(env.CATALOG_FILE + '.error')) {
      const error = JSON.parse(fs.readFileSync(env.CATALOG_FILE + '.error', 'utf8'));
      res.writeHead(error.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(error.body)); return;
    }
    if (url.pathname === '/api/model') {
      reads++;
      fs.writeFileSync(env.ENDPOINT_FILE + '.read', String(reads));
      if (fs.existsSync(env.CATALOG_FILE + '.hang') || reads > 1 && fs.existsSync(env.CATALOG_FILE + '.hang-after-first')) {
        fs.writeFileSync(env.ENDPOINT_FILE + '.model-pending', '');
        res.on('close', () => fs.writeFileSync(env.ENDPOINT_FILE + '.model-aborted', ''));
        return;
      }
      while (fs.existsSync(env.CATALOG_FILE + '.hold')) await new Promise(resolve => setTimeout(resolve, 10));
      if (res.destroyed) return;
    }
    const catalog = JSON.parse(fs.readFileSync(env.CATALOG_FILE, 'utf8'))
      .filter(/** @param {WireObject} model */ model => activated || model.providerID !== 'opencode-go');
    // A fresh native instance loads its command catalog after its first read.
    let data = url.pathname === '/api/model'
      ? catalog
      : url.pathname === '/api/skill'
        ? (fs.existsSync(env.CATALOG_FILE + '.skills') ? JSON.parse(fs.readFileSync(env.CATALOG_FILE + '.skills', 'utf8')) : [{ id: 'writing', name: 'writing', description: 'Writing guide', path: '/skills/writing/SKILL.md', content: '' }])
        : (fs.existsSync(env.CATALOG_FILE + '.commands') ? JSON.parse(fs.readFileSync(env.CATALOG_FILE + '.commands', 'utf8')) : [{ name: 'review', description: 'Review changes' }]);
    // Older v2 instances can return empty startup snapshots before discovery completes, without events.
    const resourceReads = url.pathname === '/api/model' ? reads : url.pathname === '/api/command' ? ++commandReads : ++skillReads;
    if (resourceReads <= Number(env.EMPTY_INITIAL_READS || 0)) data = [];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ location: { directory: process.cwd() }, data }));
};
return { handle,
  async beforeSubscribe(res) {
      fs.writeFileSync(env.ENDPOINT_FILE + '.event-pending', '');
      res.on('close', () => fs.writeFileSync(env.ENDPOINT_FILE + '.event-closed', ''));
      while (fs.existsSync(env.CATALOG_FILE + '.event-hold')) await new Promise(resolve => setTimeout(resolve, 10));
      if (res.destroyed) return;
  },
  afterSubscribe() { fs.writeFileSync(env.ENDPOINT_FILE + '.subscribed', ''); },
  async ready(url) {
    // Publish atomically: tests poll for this file and read it immediately.
    fs.writeFileSync(env.ENDPOINT_FILE + '.tmp', url);
    fs.renameSync(env.ENDPOINT_FILE + '.tmp', env.ENDPOINT_FILE);
    fs.writeFileSync(env.ENDPOINT_FILE + '.pid', String(process.pid));
    await waitForRelease('.ready-hold');
    setTimeout(() => process.stdout.write(JSON.stringify({ url: env.INVALID_READY === '1' ? 'https://example.com' : url }) + '\n'), Number(env.READY_DELAY_MS || 0));  },
  close() { for (const suffix of ['', '.providers', '.commands', '.skills']) fs.unwatchFile(env.CATALOG_FILE + suffix); },
};
}

/** @param {PeerContext} context @returns {Scenario} */
function historyScenario(context) {
  const options = context.options;
  /** @type {Handler} */
  const handle = async (req, res, url, body, route) => {
    const match = /^\/api\/session\/([^/]+)(?:\/(message|fork))?$/.exec(route);
    const id = match && decodeURIComponent(match[1]);
    const state = fs.existsSync(env.OPENCODE_DB) ? JSON.parse(fs.readFileSync(env.OPENCODE_DB, 'utf8')) : {};
    const sessions = options.historyFormat === 'checkpoint' ? state.sessions : state;
    const value = id ? sessions[id] : undefined;
    if (!value || !match) {
      res.writeHead(404).end(JSON.stringify({ _tag: 'SessionNotFoundError', sessionID: id, message: 'Session not found: ' + id })); return;
    }
    /** @type {HistorySession} */
    const session = Array.isArray(value) ? { messages: value } : value;
    if (match[2] === 'message') {
      replyHistoryPage(res, url, session.messages, options.pageSize); return;
    }
    if (match[2] === 'fork' && req.method === 'POST') {
      if (options.failFork) { res.writeHead(500).end('Native fork failed'); return; }
      const boundary = body.before ? session.messages.findIndex(message => message.id === body.before) : session.messages.length;
      if (boundary < 0) { res.writeHead(400).end(); return; }
      if (options.historyFormat === 'checkpoint') state.requests.push(body);
      const child = options.forkId || 'child-' + (state.requests?.length || Object.keys(sessions).length);
      const messages = session.messages.slice(0, boundary).map((message, index) => ({ ...message, id: child + '-' + index }));
      sessions[child] = options.historyFormat === 'checkpoint' ? messages : { ...session, messages };
      fs.writeFileSync(env.OPENCODE_DB, JSON.stringify(state));
      res.end(JSON.stringify({ data: { id: child } })); return;
    }
    res.end(JSON.stringify({ data: { id, ...(session.model ? { model: session.model } : {}) } }));
  };
  return { handle };
}

module.exports = { startNativePeer };
if (require.main === module) startNativePeer(JSON.parse(fs.readFileSync(__filename + '.json', 'utf8')));
