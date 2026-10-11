import { NativePeer } from '@test/helpers/deepseek/NativePeer';

let peer: NativePeer;

beforeEach(async () => {
  peer = new NativePeer();
  peer.onCall = method => method === 'session/list' ? { items: [] } : `${method} answered`;
  await peer.open();
});
afterEach(async () => { jest.useRealTimers(); await peer.close(); });

it('runs one fork at a time and lets only an ephemeral fork hold a token, withdrawn even when native refuses', async () => {
  let releaseFirst!: () => void;
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  peer.onCall = async (method, args) => {
    if (method === 'session/list') return { items: [] };
    if (method !== 'session/fork') return `${method} answered`;
    if (args.request.sessionId === 'refused') throw Object.assign(new Error('fork refused'), { code: 'session/fork-unavailable' });
    if (peer.calls.filter(call => call.method === 'session/fork').length === 1) await held;
    return { sessionId: `fork-${peer.calls.filter(call => call.method === 'session/fork').length}` };
  };
  const { deepseek, lifecycle } = peer.host();
  try {
    const lease = await deepseek.attach();
    expect(lease.ephemeral).toBe(true);
    // A persistent fork of the same parent and checkpoint would claim the token if it reached native concurrently.
    const ephemeral = lease.fork({ sessionId: 'saved', atSeq: 4 }, true);
    const persistent = lease.fork({ sessionId: 'saved', atSeq: 4 }, false);
    await until(() => peer.calls.some(call => call.method === 'session/fork'));
    await flush();
    expect(peer.calls.filter(call => call.method === 'session/fork')).toHaveLength(1);
    releaseFirst();
    expect(await ephemeral).toBe('fork-1');
    expect(await persistent).toBe('fork-2');
    await expect(lease.fork({ sessionId: 'refused', atSeq: 1 }, true)).rejects.toThrow('fork refused');
    expect(await lease.fork({ sessionId: 'saved', atSeq: 4 }, false)).toBe('fork-4');
    expect(lifecycle.ephemeralForks).toEqual([
      { parent: 'saved', atSeq: 4, forksAtOffer: 0, forksAtWithdraw: 1 },
      { parent: 'refused', atSeq: 1, forksAtOffer: 2, forksAtWithdraw: 3 },
    ]);
    lease.release();
  } finally { await deepseek.dispose(); }
});

it('refuses an ephemeral fork on a process whose plugin is not ready instead of letting native store it', async () => {
  const { deepseek, lifecycle } = peer.host({ ephemeralReady: false });
  try {
    const lease = await deepseek.attach();
    await expect(lease.fork({ sessionId: 'saved', atSeq: 1 }, true)).rejects.toThrow(/ephemeral/i);
    expect(peer.calls.some(call => call.method === 'session/fork')).toBe(false);
    expect(lifecycle.ephemeralForks).toEqual([]);
    lease.release();
  } finally { await deepseek.dispose(); }
});

it('keeps an ephemeral fork token until native work ends: no client deadline, and an ambiguous failure retires the process first', async () => {
  let finish!: () => void;
  const slow = new Promise<void>(resolve => { finish = resolve; });
  peer.onCall = async (method, args) => {
    if (method === 'session/list') return { items: [] };
    if (method !== 'session/fork') return `${method} answered`;
    if (args.request.atSeq === 1) { await slow; return { sessionId: 'slow-fork' }; }
    // A failure native did not classify: the fork may still complete inside the process.
    throw new Error('connection reset');
  };
  const { deepseek, lifecycle } = peer.host();
  try {
    const lease = await deepseek.attach();
    // Only the client deadline is virtual; the fixture server answers on immediates.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const forking = lease.fork({ sessionId: 'saved', atSeq: 1 }, true);
    forking.catch(() => undefined);
    for (let turns = 0; !peer.calls.some(call => call.method === 'session/fork'); turns++) {
      if (turns > 10_000) throw new Error('Fork never reached native.');
      await flush();
    }
    // Native forks have no cancellation; a client deadline would withdraw the token while native still forks.
    jest.advanceTimersByTime(120_000);
    await flush();
    expect(lifecycle.ephemeralForks[0].forksAtWithdraw).toBeUndefined();
    finish();
    expect(await forking).toBe('slow-fork');
    jest.useRealTimers();

    const lost = jest.fn();
    lease.onLost(lost);
    await expect(lease.fork({ sessionId: 'saved', atSeq: 2 }, true)).rejects.toThrow('connection reset');
    // The token stays published until the process that might still claim it is gone.
    expect(lifecycle.ephemeralForks[1]).toEqual({ parent: 'saved', atSeq: 2, forksAtOffer: 1 });
    expect(lifecycle.disposed).toBe(1);
    expect(lost).toHaveBeenCalledWith('transport', expect.any(Error));
    lease.release();
  } finally { await deepseek.dispose(); }
});

it.each([false, true])('retires the process after an unclassified failure of any fork (ephemeral %s) so the unfinished fork cannot claim a later token', async ephemeralFork => {
  peer.onCall = async (method, args) => {
    if (method === 'session/list') return { items: [] };
    if (method !== 'session/fork') return `${method} answered`;
    if (args.request.atSeq === 9) throw Object.assign(new Error('native refused'), { code: 'session/fork-unavailable' });
    throw new Error('connection reset');
  };
  const { deepseek, lifecycle } = peer.host();
  try {
    const lease = await deepseek.attach();
    // A native refusal proves no fork exists and keeps the process.
    await expect(lease.fork({ sessionId: 'saved', atSeq: 9 }, ephemeralFork)).rejects.toThrow('native refused');
    expect(lifecycle.disposed).toBe(0);
    const lost = jest.fn();
    lease.onLost(lost);
    await expect(lease.fork({ sessionId: 'saved', atSeq: 2 }, ephemeralFork)).rejects.toThrow('connection reset');
    expect(lifecycle.disposed).toBe(1);
    expect(lost).toHaveBeenCalledWith('transport', expect.any(Error));
    // Only a refused ephemeral fork withdrew its token; the unfinished one stays offered until its process is gone.
    expect(lifecycle.ephemeralForks).toEqual(ephemeralFork
      ? [{ parent: 'saved', atSeq: 9, forksAtOffer: 0, forksAtWithdraw: 1 }, { parent: 'saved', atSeq: 2, forksAtOffer: 1 }] : []);
    lease.release();
  } finally { await deepseek.dispose(); }
});

it.each([true, false])('retires the process when a native fork never settles instead of blocking every later fork (plugin ready %s)', async ready => {
  peer.onCall = async method => {
    if (method === 'session/list') return { items: [] };
    if (method === 'session/fork') return new Promise(() => {});
    return `${method} answered`;
  };
  const { deepseek, lifecycle } = peer.host({ ephemeralReady: ready });
  try {
    const lease = await deepseek.attach();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    // Without the plugin the unfinished fork could still persist an orphan after Claudian reported it failed.
    const hung = lease.fork({ sessionId: 'saved', atSeq: 1 }, ready);
    const queued = lease.fork({ sessionId: 'saved', atSeq: 1 }, false);
    const settled = jest.fn();
    hung.then(settled, settled); queued.then(settled, settled);
    for (let turns = 0; !peer.calls.some(call => call.method === 'session/fork'); turns++) {
      if (turns > 10_000) throw new Error('Fork never reached native.');
      await flush();
    }
    // Native forks may legitimately wait on MCP discovery; minutes pass before the Host gives up.
    jest.advanceTimersByTime(4 * 60_000);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60_000);
    jest.useRealTimers();
    await expect(hung).rejects.toThrow(/did not finish/);
    await expect(queued).rejects.toThrow();
    expect(lifecycle.disposed).toBe(1);
    // The queued fork never reached native: the retired process received no second fork.
    expect(peer.calls.filter(call => call.method === 'session/fork')).toHaveLength(1);
    expect(lifecycle.ephemeralForks).toEqual(ready ? [{ parent: 'saved', atSeq: 1, forksAtOffer: 0 }] : []);
    lease.release();
  } finally { await deepseek.dispose(); }
});

it('retires the process when a refused fork\'s token cannot be withdrawn, but keeps a fork that claimed its token', async () => {
  peer.onCall = async (method, args) => {
    if (method === 'session/list') return { items: [] };
    if (method !== 'session/fork') return `${method} answered`;
    if (args.request.atSeq === 9) throw Object.assign(new Error('native refused'), { code: 'session/fork-unavailable' });
    return { sessionId: 'side' };
  };
  const { deepseek, lifecycle } = peer.host({ failWithdrawals: true });
  try {
    const lease = await deepseek.attach();
    // The successful fork claimed its token, so a stale entry can never be claimed again.
    expect(await lease.fork({ sessionId: 'saved', atSeq: 4 }, true)).toBe('side');
    expect(lifecycle.disposed).toBe(0);
    // A refused fork leaves its token unclaimed; a later durable fork of that checkpoint would take it.
    await expect(lease.fork({ sessionId: 'saved', atSeq: 9 }, true)).rejects.toThrow('native refused');
    expect(lifecycle.disposed).toBe(1);
    lease.release();
  } finally { await deepseek.dispose(); }
});

it('lets a caller stop waiting for its fork and never starts a fork whose lease or process is gone', async () => {
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  peer.onCall = async method => {
    if (method === 'session/list') return { items: [] };
    if (method !== 'session/fork') return `${method} answered`;
    await held;
    return { sessionId: 'side' };
  };
  const { deepseek, lifecycle } = peer.host();
  try {
    const lease = await deepseek.attach();
    const other = await deepseek.attach();
    const stop = new AbortController();
    const waiting = lease.fork({ sessionId: 'saved', atSeq: 4 }, true, stop.signal);
    const queued = other.fork({ sessionId: 'saved', atSeq: 5 }, false);
    await until(() => peer.calls.some(call => call.method === 'session/fork'));
    stop.abort();
    await expect(waiting).rejects.toThrow(/cancel/i);
    // The Host keeps the token until native settles, whatever the caller does.
    expect(lifecycle.ephemeralForks[0].forksAtWithdraw).toBeUndefined();
    other.release();
    finish();
    await expect(queued).rejects.toThrow(/released/);
    await until(() => lifecycle.ephemeralForks[0].forksAtWithdraw !== undefined);
    expect(peer.calls.filter(call => call.method === 'session/fork')).toHaveLength(1);
    lease.release();
  } finally { await deepseek.dispose(); }
});

it.each([true, false])('hands out ephemeral identities only from a process whose plugin is ready (%s)', async ready => {
  const { deepseek } = peer.host({ ephemeralReady: ready });
  try {
    const lease = await deepseek.attach();
    const mint = (): string => { try { return lease.ephemeralSessionId(); } catch (error) { return `refused: ${(error as Error).message}`; } };
    expect(mint()).toMatch(ready ? /^claudian-ephemeral-[0-9a-f-]{36}$/ : /^refused: DeepSeek cannot keep this session ephemeral/);
    lease.release();
  } finally { await deepseek.dispose(); }
});

it.each([true, false])('reports per process whether ephemeral sessions are available (%s) and tells processes apart', async ready => {
  const { deepseek, lifecycle } = peer.host({ ephemeralReady: ready });
  try {
    const first = await deepseek.attach();
    expect(first.ephemeral).toBe(ready);
    const second = await deepseek.attach();
    expect(second.generation).toBe(first.generation);
    lifecycle.exit();
    first.release(); second.release();
    const replacement = await deepseek.attach();
    expect(replacement.generation).not.toBe(first.generation);
    replacement.release();
  } finally { await deepseek.dispose(); }
});

it('shares one startup between attachments and reads, then stops only after the last user idles', async () => {
  let release!: () => void;
  const startup = new Promise<void>(resolve => { release = resolve; });
  // Idle timers are virtual so no wall-clock delay can stand in for the lease holding the process.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  const { deepseek, lifecycle } = peer.host({ idleMs: 30, beforeStart: () => startup });
  try {
    const attaching = deepseek.attach();
    const reading = deepseek.read(reader => reader.call('session/modelCatalog'));
    release();
    const lease = await attaching;
    expect(await reading).toBe('session/modelCatalog answered');
    expect(lifecycle.starts).toBe(1);
    // The read has left; only the held lease keeps the process past many idle periods.
    jest.advanceTimersByTime(300);
    await flush();
    expect(lifecycle.disposed).toBe(0);
    lease.release();
    jest.advanceTimersByTime(29);
    await flush();
    expect(lifecycle.disposed).toBe(0);
    jest.advanceTimersByTime(1);
    jest.useRealTimers();
    await until(() => lifecycle.disposed === 1);
    expect(await deepseek.read(reader => reader.call('session/projections', { request: { sessionId: 'saved' } }))).toBe('session/projections answered');
    expect(lifecycle.starts).toBe(2);
    await expect(deepseek.read(reader => reader.call('session/create'))).rejects.toThrow(/cannot call session\/create/);
  } finally { await deepseek.dispose(); }
});

it('keeps a shared startup for remaining users when one waiter cancels, and fences transitions', async () => {
  const { deepseek, lifecycle } = peer.host({ beforeStart: () => new Promise(resolve => setTimeout(resolve, 20)) });
  try {
    const aborted = new AbortController();
    const cancelled = deepseek.read(reader => reader.call('session/modelCatalog'), aborted.signal);
    const kept = deepseek.read(reader => reader.call('session/modelCatalog'));
    aborted.abort();
    await expect(cancelled).rejects.toThrow(/abort|cancel/);
    expect(await kept).toBe('session/modelCatalog answered');
    await deepseek.beginTransition();
    expect(lifecycle.disposed).toBe(1);
    const waiting = deepseek.read(reader => reader.call('session/modelCatalog'));
    // Launch resolution and spawn are microtask continuations; an unfenced read would have started by now.
    await flush();
    expect(lifecycle.starts).toBe(1);
    deepseek.endTransition();
    expect(await waiting).toBe('session/modelCatalog answered');
    expect(lifecycle.starts).toBe(2);
  } finally { await deepseek.dispose(); }
});

it('notifies attachments when the process exits and starts a replacement only after the old one released its writers', async () => {
  let finishTeardown!: () => void;
  const teardown = new Promise<void>(resolve => { finishTeardown = resolve; });
  const { deepseek, lifecycle } = peer.host({ onDispose: () => teardown });
  try {
    const lease = await deepseek.attach();
    const lost = jest.fn();
    lease.onLost(lost);
    lifecycle.exit();
    expect(lost).toHaveBeenCalledWith('process-exited', expect.any(Error));
    const replacement = deepseek.attach();
    // Launch resolution and spawn are microtask continuations; only the held teardown can delay the replacement.
    await flush();
    expect(lifecycle.starts).toBe(1);
    finishTeardown();
    (await replacement).release();
    expect(lifecycle.starts).toBe(2);
    lease.release();
  } finally { finishTeardown(); await deepseek.dispose(); }
});

it('never hands out a lease on a process that exited while startup was finishing', async () => {
  const { deepseek, lifecycle } = peer.host();
  try {
    peer.onCall = method => { if (method === 'session/list') lifecycle.exit(); return { items: [] }; };
    await expect(deepseek.attach()).rejects.toThrow(/exited/);
    peer.onCall = method => method === 'session/list' ? { items: [] } : `${method} answered`;
    const lease = await deepseek.attach();
    expect(await lease.client.call('session/modelCatalog')).toBe('session/modelCatalog answered');
    expect(lifecycle.starts).toBe(2);
    lease.release();
  } finally { await deepseek.dispose(); }
});

it('fails attached sessions recoverably and replaces the process when reconnection cannot list sessions', async () => {
  const { deepseek, lifecycle } = peer.host();
  try {
    const lease = await deepseek.attach();
    const lost = new Promise<[string, Error]>(resolve => lease.onLost((loss, error) => resolve([loss, error])));
    peer.onCall = method => method === 'session/list' ? Promise.reject(new Error('roster unavailable')) : `${method} answered`;
    for (const stream of peer.streams.values()) stream.socket.terminate();
    const [loss, error] = await lost;
    expect(loss).toBe('transport');
    expect(error.message).toMatch(/roster unavailable/);
    await until(() => lifecycle.disposed === 1);
    lease.release();
    peer.onCall = method => method === 'session/list' ? { items: [] } : `${method} answered`;
    const replacement = await deepseek.attach();
    expect(await replacement.client.call('session/modelCatalog')).toBe('session/modelCatalog answered');
    expect(lifecycle.starts).toBe(2);
    replacement.release();
  } finally { await deepseek.dispose(); }
});

/** Settles every pending microtask continuation. */
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Host fixture timed out.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
