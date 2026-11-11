import { ACPNativeOwnerSlot } from '@/providers/acp';

interface Owner {
  readonly id: number;
  ready: boolean;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

describe('ACPNativeOwnerSlot', () => {
  it('shares one startup between concurrent callers and reuses the started owner', async () => {
    const releases: Array<[number, boolean]> = [];
    const slot = new ACPNativeOwnerSlot<Owner>(owner => {
      releases.push([owner.id, false]);
      return Promise.resolve();
    });
    const gate = deferred();
    let starts = 0;
    const start = async (): Promise<Owner> => {
      starts += 1;
      const owner = { id: starts, ready: false };
      slot.install(owner);
      await gate.promise;
      owner.ready = true;
      return owner;
    };

    const first = slot.ensure(owner => owner.ready, start);
    const second = slot.ensure(owner => owner.ready, start);
    gate.resolve();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(await slot.ensure(owner => owner.ready, start)).toBe(a);
    expect(starts).toBe(1);
    expect(releases).toEqual([]);
  });

  it('stops an owner installed by a startup that was pending when shutdown began', async () => {
    const releases: Array<[number, boolean]> = [];
    const slot = new ACPNativeOwnerSlot<Owner>((owner, wasCurrent) => {
      releases.push([owner.id, wasCurrent]);
      return Promise.resolve();
    });
    const gate = deferred();
    const startup = slot.ensure(() => true, async () => {
      await gate.promise;
      const owner = { id: 1, ready: true };
      slot.install(owner);
      return owner;
    });

    const shutdown = slot.shutdown();
    gate.resolve();
    await shutdown;

    await expect(startup).resolves.toEqual({ id: 1, ready: true });
    expect(releases).toEqual([[1, true]]);
    expect(slot.current).toBeNull();
  });

  it('releases listeners only on the detach that removed the current owner', async () => {
    const releases: Array<[number, boolean]> = [];
    const slot = new ACPNativeOwnerSlot<Owner>((owner, wasCurrent) => {
      releases.push([owner.id, wasCurrent]);
      return Promise.resolve();
    });
    const owner = { id: 1, ready: true };
    slot.install(owner);

    await slot.detach(owner);
    await slot.detach(owner);

    expect(releases).toEqual([[1, true], [1, false]]);
  });

  it('still stops a later owner when the first stop fails, then reports that failure', async () => {
    const released: number[] = [];
    const slot = new ACPNativeOwnerSlot<Owner>(owner => {
      released.push(owner.id);
      return owner.id === 1 ? Promise.reject(new Error('stop failed')) : Promise.resolve();
    });
    slot.install({ id: 1, ready: true });
    const gate = deferred();
    void slot.ensure(() => false, async () => {
      await gate.promise;
      const replacement = { id: 2, ready: true };
      slot.install(replacement);
      return replacement;
    });

    const shutdown = slot.shutdown();
    gate.resolve();

    await expect(shutdown).rejects.toThrow('stop failed');
    expect(released).toEqual([1, 2]);
  });
});
