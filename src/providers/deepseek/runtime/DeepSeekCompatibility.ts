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

/** Claudian keeps the Host's stdin open for its whole lifetime; EOF means the owner is gone. */
export const DEEPSEEK_LIFECYCLE_SOURCE = String.raw`
export const name = 'claudian-lifecycle';

export function apply() {
  const exit = () => process.kill(process.pid, 'SIGTERM');
  process.stdin.once('end', exit);
  process.stdin.once('error', exit);
  process.stdin.resume();
}
`;

/** Native session ids with this prefix live only in the Host process; Claudian chooses them for ephemeral roots. */
export const DEEPSEEK_EPHEMERAL_PREFIX = 'claudian-ephemeral-';

/**
 * Keeps ephemeral sessions in Host memory. It decorates the mounted persistence backend through its public seam, so
 * every other session stays native. Ephemeral: a prefixed id, a fork that claims a Claudian-offered token for its parent
 * and checkpoint, and every child of an ephemeral session. Durable stores that index sessions (projection cache,
 * workspace membership, archive and pin sets) never record one, and their oversized tool output spills into Claudian's
 * launch directory, removed with the Host. The ready file tells Claudian every guard is in place.
 */
export const DEEPSEEK_EPHEMERAL_SOURCE = String.raw`
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  if (!['stateFile', 'readyFile', 'spillRoot'].every(key => typeof config?.[key] === 'string' && config[key])) {
    throw new TypeError('Claudian ephemeral sessions require a state file, a ready file and a spill directory.');
  }
  const ready = { protocol: 1, persistence: false, projectionGuard: false, workspaceGuard: false, spillGuard: false };
  const report = () => {
    const temporary = config.readyFile + '.tmp';
    writeFileSync(temporary, JSON.stringify(ready), { mode: 0o600 });
    renameSync(temporary, config.readyFile);
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
