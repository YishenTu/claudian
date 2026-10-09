import { NativePeer } from '@test/helpers/deepseek/NativePeer';

let peer: NativePeer;

beforeEach(async () => {
  peer = new NativePeer();
  peer.onCall = method => method === 'session/list' ? { items: [] } : `${method} answered`;
  await peer.open();
});
afterEach(async () => { await peer.close(); });

it('shares one startup between attachments and reads, then stops only after the last user idles', async () => {
  let release!: () => void;
  const startup = new Promise<void>(resolve => { release = resolve; });
  const { deepseek, lifecycle } = peer.host({ idleMs: 30, beforeStart: () => startup });
  try {
    const attaching = deepseek.attach();
    const reading = deepseek.read(reader => reader.call('session/modelCatalog'));
    release();
    const lease = await attaching;
    expect(await reading).toBe('session/modelCatalog answered');
    expect(lifecycle.starts).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(lifecycle.disposed).toBe(0);
    lease.release();
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
    await new Promise(resolve => setTimeout(resolve, 10));
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
    await new Promise(resolve => setTimeout(resolve, 20));
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

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Host fixture timed out.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
