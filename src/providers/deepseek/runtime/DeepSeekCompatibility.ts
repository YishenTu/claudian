/**
 * Static native plugins, bundled as text and written beside the launch patch. They import only Node
 * built-ins. Prompts never appear in code: each preset reads its own prompt file at every assembly, and chat agents
 * read the code-mode file at creation and at each turn start.
 */
export const DEEPSEEK_COMPATIBILITY_SOURCE = String.raw`
import { readFileSync } from 'node:fs';

export const name = 'claudian-compatibility';
export const inject = ['systemPrompt', 'tools'];

export function apply(ctx, config) {
  if (typeof config?.promptFile !== 'string' || !config.promptFile) {
    throw new TypeError('Claudian compatibility requires a prompt file.');
  }
  const allowed = ['read', 'read_image', 'glob', 'grep'];
  if (config.allow !== undefined && (!Array.isArray(config.allow)
    || config.allow.some(value => !allowed.includes(value))
    || (config.allow.length !== 0 && (config.allow.length !== 4 || new Set(config.allow).size !== 4)))) {
    throw new TypeError('Claudian auxiliary policy must be passive or read-only.');
  }
  if (config.codeModeFile !== undefined && (typeof config.codeModeFile !== 'string' || !config.codeModeFile || config.allow !== undefined)) {
    throw new TypeError('Claudian code mode requires a chat preset and a mode file.');
  }
  const prompt = () => readFileSync(config.promptFile, 'utf8');
  for (const [name, order, text] of [
    ['deployment:persona-prefix', 'DEPLOYMENT_PERSONA_PREFIX', prompt],
    ['deployment:persona-suffix', 'DEPLOYMENT_PERSONA_SUFFIX', ''],
    ['harness:identity', 'HARNESS_IDENTITY', ''],
    ['harness:source', 'HARNESS_SOURCE', ''],
    ['app:web-surface', 'WEB_SURFACE', ''],
    ['ui:deliverable-file-references', 'DELIVERABLE_FILE_REFERENCES', ''],
  ]) {
    ctx.effect(() => ctx.systemPrompt.section({
      name, order: ctx.systemPrompt.getSectionOrder(order), text,
      interpolate: false, complete: false,
    }), 'claudian.compatibility.section()');
  }
  if (config.allow !== undefined) {
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.presentAs('native');
      agent.ctx.tools.restrict({ allow: config.allow });
    });
  }
  if (config.codeModeFile !== undefined) {
    // Chat presentation follows Claudian's live code-mode preference, read only between turns.
    const declared = new WeakMap();
    const present = agent => {
      let mode = 'native';
      try { if (readFileSync(config.codeModeFile, 'utf8') === 'both') mode = 'both'; } catch {}
      const current = declared.get(agent);
      if (current?.mode === mode) return;
      current?.dispose();
      declared.set(agent, { mode, dispose: agent.ctx.tools.presentAs(mode) });
    };
    ctx.on('agent/created', ({ agent }) => present(agent));
    ctx.on('agent/status', ({ agent, status }) => { if (status === 'running') present(agent); });
  }
}
`;

/** Registers only Claudian's session tools; the Host owns routing and the execution session owns policy/lifetime. */
export const DEEPSEEK_SESSIONS_SOURCE = String.raw`
import { readFile } from 'node:fs/promises';

export const name = 'claudian-sessions';
export const inject = ['tools', 'loader'];

export async function apply(ctx, config) {
  if (typeof config?.endpointFile !== 'string' || !Array.isArray(config.tools)) {
    throw new TypeError('Claudian sessions requires an endpoint file and tool specs.');
  }
  const { defineTool } = await ctx.loader.import('@deepseek-ai/dsh-tools');
  for (const spec of config.tools) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: Object.fromEntries(Object.entries(spec.inputSchema.properties).map(([key, value]) =>
        [key, { ...value, ...(spec.inputSchema.required?.includes(key) ? { required: true } : {}) }])),
      // Mailbox admission answers immediately; there is no wait for the recipient's turn.
      timeoutMs: 60_000,
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          text: { type: 'string', required: true }, isError: { type: 'boolean', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const callerNativeId = exec.agent?.id;
        if (typeof callerNativeId !== 'string' || !callerNativeId || typeof exec.callId !== 'string' || !exec.callId) throw new Error('Unbound Claudian session tool caller.');
        // Read on every call: an endpoint replacement never restarts the shared native Host.
        const route = JSON.parse(await readFile(config.endpointFile, 'utf8'));
        if (typeof route.url !== 'string' || typeof route.routeId !== 'string') throw new Error('Claudian session tools are unavailable.');
        const response = await fetch(route.url, {
          method: 'POST', headers: { 'Content-Type': 'application/json', [config.routeHeader]: route.routeId },
          body: JSON.stringify({ tool: spec.name, args: { callId: exec.callId, args }, callerNativeId }), signal: exec.signal,
        });
        if (!response.ok) throw new Error('Claudian session tool endpoint returned HTTP ' + response.status);
        const result = await response.json();
        if (typeof result?.text !== 'string' || typeof result?.isError !== 'boolean') throw new Error('Invalid Claudian session tool result.');
        if (result.isError) throw new Error(result.text);
        return result;
      },
    }));
  }
}
`;

/**
 * Claudian keeps the Host's stdin open for its whole lifetime; EOF means the owner is gone. Native runProfile's SIGTERM
 * listener runs its bounded interrupt, which a delivered signal never reaches on Windows (TerminateProcess), so it is
 * emitted in-process, once: a second interrupt forces exit.
 */
export const DEEPSEEK_LIFECYCLE_SOURCE = String.raw`
export const name = 'claudian-lifecycle';

export function apply() {
  let ended = false;
  const exit = () => {
    if (ended) return;
    ended = true;
    if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM'); else process.exit(0);
  };
  process.stdin.on('end', exit).on('error', exit).resume();
}
`;

/** Native session ids with this prefix live only in the Host process; Claudian chooses them for ephemeral roots. */
export const DEEPSEEK_EPHEMERAL_PREFIX = 'claudian-ephemeral-';

/**
 * Keeps ephemeral sessions in Host memory. It decorates the mounted persistence backend through its public seam, so
 * every other session stays native. Ephemeral: a prefixed id, a fork that claims a Claudian-offered token for its parent
 * and checkpoint, and every child of an ephemeral session. Durable stores that index sessions (projection cache,
 * workspace membership, archive and pin sets) never record one. Attachments, image caches and oversized tool output use
 * Claudian's launch directory, removed with the Host. The ready file tells Claudian every guard is in place.
 */
export const DEEPSEEK_EPHEMERAL_SOURCE = String.raw`
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'claudian-ephemeral';
export const inject = ['sessionPersistence'];

const PREFIX = '${DEEPSEEK_EPHEMERAL_PREFIX}';

class MemoryHandle {
  #closed = false;
  constructor(entry, access) { this.entry = entry; this.access = access; }
  get id() { return this.entry.header.id; }
  get header() { return this.entry.header; }
  get inheritedEventCount() { return this.entry.inheritedEventCount; }
  #open() { if (this.#closed) throw new Error('Ephemeral session "' + this.id + '" handle is closed.'); }
  async read(offset = 0, length) {
    this.#open();
    const end = length === undefined ? undefined : offset + length;
    return { eventState: 'detached', events: this.entry.events.slice(offset, end).map(event => structuredClone(event)) };
  }
  async append(events) {
    this.#open();
    if (this.access !== 'write') throw new Error('Ephemeral session "' + this.id + '" handle is read-only.');
    this.entry.add(events);
  }
  async flush() { this.#open(); }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.entry.writer === this) this.entry.writer = undefined;
  }
  async [Symbol.asyncDispose]() { await this.close(); }
}

class MemoryEntry {
  writer = undefined;
  events = [];
  constructor(header, inheritedEventCount) { this.header = header; this.inheritedEventCount = inheritedEventCount; }
  // A fork's log starts with its inherited seed at seq 0. Handle appends and live events overlap; the log stays
  // contiguous by seq.
  add(events) {
    for (const event of events) {
      const next = this.events.length;
      if (event.seq < next) continue;
      if (event.seq > next) throw new Error('Ephemeral session "' + this.header.id + '" expected event ' + next + ', got ' + event.seq + '.');
      this.events.push(structuredClone(event));
    }
  }
}

export function apply(ctx, config) {
  if (!['stateFile', 'readyFile', 'spillRoot', 'attachmentRoot'].every(key => typeof config?.[key] === 'string' && config[key])) {
    throw new TypeError('Claudian ephemeral sessions require state, readiness, spill and attachment paths.');
  }
  const ready = { persistence: false, projectionGuard: false, workspaceGuard: false, spillGuard: false, attachmentGuard: false };
  const report = () => {
    const temporary = config.readyFile + '.tmp';
    writeFileSync(temporary, JSON.stringify(ready), { mode: 0o600 });
    // Windows refuses a replacement while a reader or scanner briefly holds the file; apply is synchronous.
    for (let attempt = 1; ; attempt++) {
      try { renameSync(temporary, config.readyFile); return; } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * attempt);
      }
    }
  };
  const memory = new Map();
  const claimed = new Set();
  // Claudian owns the state file and offers one token per fork; this process only remembers which it claimed.
  const claimFork = (parent, inheritedEventCount) => {
    let forks;
    try { forks = JSON.parse(readFileSync(config.stateFile, 'utf8')).forks; } catch { return false; }
    const offer = Array.isArray(forks) && forks.find(fork => fork.parent === parent && fork.atSeq + 1 === inheritedEventCount && !claimed.has(fork.token));
    if (!offer) return false;
    claimed.add(offer.token);
    return true;
  };
  const isEphemeral = (header, inheritedEventCount) => header.id.startsWith(PREFIX)
    || (header.parentSession !== undefined && (memory.has(header.parentSession)
      || (header.origin === undefined && claimFork(header.parentSession, inheritedEventCount))));

  const backend = ctx.get('sessionPersistence');
  const original = { create: backend.create, open: backend.open, stat: backend.stat };
  Object.assign(backend, {
    async create(header, options) {
      if (!isEphemeral(header, options?.inheritedEventCount ?? 0)) return original.create.call(backend, header, options);
      options?.signal?.throwIfAborted();
      if (memory.has(header.id)) throw new Error('Ephemeral session "' + header.id + '" already exists.');
      const entry = new MemoryEntry(structuredClone(header), options?.inheritedEventCount ?? 0);
      memory.set(header.id, entry);
      return entry.writer = new MemoryHandle(entry, 'write');
    },
    async open(id, access, options) {
      const entry = memory.get(id);
      if (!entry) return original.open.call(backend, id, access, options);
      if (access !== 'write') return new MemoryHandle(entry, 'read');
      if (entry.writer) throw new Error('Ephemeral session "' + id + '" is already owned.');
      return entry.writer = new MemoryHandle(entry, 'write');
    },
    async stat(id, options) {
      const entry = memory.get(id);
      if (!entry) return original.stat.call(backend, id, options);
      return { header: entry.header, revision: 'memory:' + entry.events.length, eventCount: entry.events.length };
    },
  });
  ctx.effect(() => () => { Object.assign(backend, original); }, 'claudian.ephemeral.persistence');
  // The backend routes live events only to its own handles.
  ctx.on('session/event', (session, event) => {
    const entry = memory.get(session.id);
    if (entry?.writer) entry.add([event]);
  });
  ready.persistence = true;
  report();

  const wrap = (target, key, wrapper, guardCtx, label) => {
    const previous = target[key];
    target[key] = wrapper(previous);
    guardCtx.effect(() => () => { target[key] = previous; }, label);
  };
  // rc.2's public attachment API has no owner argument. RPC admission/reads use their explicit session id; tool and
  // model operations use native's async Agent initiator. Neither changes the process-wide native store's roots.
  ctx.inject(['attachments', 'agents', 'sessionController', 'loader'], async guardCtx => {
    const [{ LocalAttachmentStore }, { DeepSeekUploadIndex }] = await Promise.all([
      guardCtx.loader.import('@deepseek-ai/dsh-attachment-local'), guardCtx.loader.import('@deepseek-ai/dsh-llm-deepseek'),
    ]);
    const store = guardCtx.attachments;
    if (!(store instanceof LocalAttachmentStore)) return;
    const temporary = new LocalAttachmentStore(guardCtx.isolate('attachments'), {
      dshHome: config.attachmentRoot, ...store.imageLimits,
      normalizedImageMaxPixels: store.normalizationPolicy.maxPixels,
      normalizedImageMaxDimension: store.normalizationPolicy.maxDimension,
      normalizedImageMaxBytes: store.normalizationPolicy.maxBytes,
      imageCompressionConcurrency: store.imageCompressionConcurrency,
    });
    const admission = new AsyncLocalStorage();
    const ephemeral = () => memory.has(admission.getStore() ?? guardCtx.agents.currentInitiator()?.id);
    for (const key of ['prompt', 'attachment']) {
      wrap(guardCtx.sessionController, key, method => function (request, ...args) {
        return admission.run(request.sessionId, () => method.call(this, request, ...args));
      }, guardCtx, 'claudian.ephemeral.attachment-' + key);
    }
    // An ephemeral fork may inherit durable references. Read those from native without copying or deleting them;
    // native's request-image implementation still puts every newly derived variant in the temporary store.
    const readNative = store.readImage.bind(store), readTemporary = temporary.readImage.bind(temporary);
    temporary.readImage = async (...args) => {
      try { return await readTemporary(...args); }
      catch (error) { if (error?.code !== 'ATTACHMENT_NOT_FOUND') throw error; return readNative(...args); }
    };
    for (const key of ['imageHostPath', 'fileHostPath']) {
      if (typeof store[key] !== 'function') continue;
      const native = store[key].bind(store), local = temporary[key].bind(temporary);
      temporary[key] = ref => { const path = local(ref); return path && existsSync(path) ? path : native(ref); };
    }
    if (typeof store.readFileStream === 'function') {
      const native = store.readFileStream.bind(store), local = temporary.readFileStream.bind(temporary);
      const path = LocalAttachmentStore.prototype.fileHostPath.bind(temporary);
      temporary.readFileStream = (...args) => existsSync(path(args[0])) ? local(...args) : native(...args);
    }
    for (const key of ['saveImage', 'saveImages', 'readImage', 'readImageRequest', 'imageHostPath',
      'saveFile', 'saveFileStream', 'readFileStream', 'fileHostPath']) {
      if (typeof store[key] !== 'function') continue;
      wrap(store, key, method => function (...args) {
        return ephemeral() ? temporary[key](...args) : method.apply(this, args);
      }, guardCtx, 'claudian.ephemeral.attachments-' + key);
    }
    // A successful Files API upload also creates a durable image index. Keep its native algorithm and locking, but
    // route ephemeral operations to a disposable index, including invalidation and quota-recovery rewrites.
    const index = new DeepSeekUploadIndex(join(config.attachmentRoot, 'uploads.json'));
    for (const key of ['get', 'commit', 'remove', 'clear']) {
      wrap(DeepSeekUploadIndex.prototype, key, method => function (...args) {
        return method.apply(ephemeral() ? index : this, args);
      }, guardCtx, 'claudian.ephemeral.uploads-' + key);
    }
    ready.attachmentGuard = true;
    report();
  });
  // The projection cache keeps one never-pruned record per session, titled with its first user message.
  ctx.inject(['storageDomain', 'sessionProjectionCache'], guardCtx => {
    const domain = guardCtx.storageDomain.get('session_projcache');
    if (!domain) { guardCtx.logger.warn('Claudian ephemeral sessions: the projection cache is not open.'); return; }
    wrap(domain.table('sessions'), 'put', put => function (key, value) {
      return memory.has(key) ? Promise.resolve() : put.call(this, key, value);
    }, guardCtx, 'claudian.ephemeral.projections');
    ready.projectionGuard = true;
    report();
  });
  // Native attaches forks to their parent's workspace; no workspace, archive or pin set may account an ephemeral session.
  ctx.inject(['storageDomain', 'workspaceRegistry'], guardCtx => {
    const domain = guardCtx.storageDomain.get('workspace');
    if (!domain) { guardCtx.logger.warn('Claudian ephemeral sessions: workspaces are not open.'); return; }
    const without = ids => ids.filter(id => !memory.has(id));
    const record = value => Array.isArray(value?.sessionIds) ? { ...value, sessionIds: without(value.sessionIds) } : value;
    const table = domain.table('workspaces');
    wrap(table, 'put', put => function (key, value) { return put.call(this, key, record(value)); }, guardCtx, 'claudian.ephemeral.workspace-put');
    wrap(table, 'update', update => function (key, fn) { return update.call(this, key, current => record(fn(current))); }, guardCtx, 'claudian.ephemeral.workspace-update');
    wrap(domain.global, 'set', set => function (value) {
      const next = { ...value };
      for (const key of ['archivedSessionIds', 'pinnedSessionIds']) if (Array.isArray(next[key])) next[key] = without(next[key]);
      return set.call(this, next);
    }, guardCtx, 'claudian.ephemeral.workspace-global');
    ready.workspaceGuard = true;
    report();
  });
  // Native spills oversized tool output to a temporary root it sweeps only after 30 days.
  ctx.inject(['spillStore'], guardCtx => {
    wrap(guardCtx.get('spillStore'), 'saveText', saveText => async function (input) {
      if (!memory.has(input.owner.sessionId)) return saveText.call(this, input);
      mkdirSync(config.spillRoot, { recursive: true, mode: 0o700 });
      const path = join(config.spillRoot, randomBytes(6).toString('hex') + '-' + String(input.suggestedName).replace(/[^A-Za-z0-9._-]/g, '_'));
      writeFileSync(path, input.content, { mode: 0o600, flag: 'wx' });
      return { locator: path, bytes: Buffer.byteLength(input.content, 'utf8'), retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' };
    }, guardCtx, 'claudian.ephemeral.spill');
    ready.spillGuard = true;
    report();
  });
}
`;
