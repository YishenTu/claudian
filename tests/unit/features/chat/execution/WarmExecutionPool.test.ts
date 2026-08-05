import {
  WarmExecutionCapacityError,
  type WarmExecutionOwner,
  WarmExecutionPool,
} from '@/features/chat/execution/WarmExecutionPool';

function createOwner(id: string, canCool = true): WarmExecutionOwner & {
  canCool: jest.Mock<boolean, []>;
  cool: jest.Mock<Promise<void>, []>;
} {
  return {
    id,
    canCool: jest.fn().mockReturnValue(canCool),
    cool: jest.fn().mockResolvedValue(undefined),
  };
}

describe('WarmExecutionPool', () => {
  it('enforces five as the minimum concurrent running session limit', async () => {
    const pool = new WarmExecutionPool(() => 3);
    const protectedOwners = Array.from(
      { length: 5 },
      (_, index) => createOwner(`protected-${index}`, false),
    );

    for (const owner of protectedOwners) {
      await pool.acquire(owner);
    }

    await expect(pool.acquire(createOwner('next'))).rejects.toEqual(
      new WarmExecutionCapacityError(5),
    );
    expect(pool.getWarmCount()).toBe(5);
  });

  it('cools the least-recently-used safe owner when the limit is reached', async () => {
    const pool = new WarmExecutionPool(() => 5);
    const first = createOwner('first');
    const second = createOwner('second');
    const owners = [
      first,
      second,
      createOwner('third'),
      createOwner('fourth'),
      createOwner('fifth'),
    ];

    for (const owner of owners) {
      await pool.acquire(owner);
    }
    await pool.acquire(first);
    await pool.acquire(createOwner('sixth'));

    expect(first.cool).not.toHaveBeenCalled();
    expect(second.cool).toHaveBeenCalledTimes(1);
    expect(pool.has('first')).toBe(true);
    expect(pool.has('second')).toBe(false);
    expect(pool.has('sixth')).toBe(true);
  });

  it('does not exceed the limit when every warm owner is protected', async () => {
    const pool = new WarmExecutionPool(() => 5);
    const protectedOwners = Array.from(
      { length: 5 },
      (_, index) => createOwner(`protected-${index}`, false),
    );

    for (const owner of protectedOwners) {
      await pool.acquire(owner);
    }

    await expect(pool.acquire(createOwner('next'))).rejects.toEqual(
      new WarmExecutionCapacityError(5),
    );
    expect(pool.getWarmCount()).toBe(5);
  });

  it('forgets released owners without cooling them', async () => {
    const pool = new WarmExecutionPool(() => 5);
    const owner = createOwner('owner');

    await pool.acquire(owner);
    pool.release(owner.id);

    expect(owner.cool).not.toHaveBeenCalled();
    expect(pool.getWarmCount()).toBe(0);
  });

  it('reconciles a lowered limit when an existing owner is used again', async () => {
    let limit = 6;
    const pool = new WarmExecutionPool(() => limit);
    const first = createOwner('first');
    const owners = [
      first,
      createOwner('second'),
      createOwner('third'),
      createOwner('fourth'),
      createOwner('fifth'),
      createOwner('sixth'),
    ];
    for (const owner of owners) {
      await pool.acquire(owner);
    }

    limit = 5;
    await pool.acquire(owners[5]);

    expect(first.cool).toHaveBeenCalledTimes(1);
    expect(owners[5].cool).not.toHaveBeenCalled();
    expect(pool.getWarmCount()).toBe(5);
  });

  it('reconciles a lowered limit when a protected owner later becomes coolable', async () => {
    let limit = 6;
    const pool = new WarmExecutionPool(() => limit);
    const owners = Array.from(
      { length: 6 },
      (_, index) => createOwner(`owner-${index}`, false),
    );
    for (const owner of owners) {
      await pool.acquire(owner);
    }

    limit = 5;
    await pool.reconcileLimit();
    expect(pool.getWarmCount()).toBe(6);

    owners[0].canCool.mockReturnValue(true);
    await pool.notifyOwnerMayCool(owners[0].id);

    expect(owners[0].cool).toHaveBeenCalledTimes(1);
    expect(owners[1].cool).not.toHaveBeenCalled();
    expect(pool.getWarmCount()).toBe(5);
  });

  it('reports when protected owners prevent immediate limit reconciliation', async () => {
    let limit = 6;
    const pool = new WarmExecutionPool(() => limit);
    for (let index = 0; index < 6; index += 1) {
      await pool.acquire(createOwner(`owner-${index}`, false));
    }

    limit = 5;

    await expect(pool.reconcileLimit()).resolves.toBe(false);
    expect(pool.getWarmCount()).toBe(6);
  });

  it('touches provider activity when choosing the least-recently-used owner', async () => {
    const pool = new WarmExecutionPool(() => 5);
    const first = createOwner('first');
    const second = createOwner('second');
    const owners = [
      first,
      second,
      createOwner('third'),
      createOwner('fourth'),
      createOwner('fifth'),
    ];
    for (const owner of owners) {
      await pool.acquire(owner);
    }

    await pool.touch(first.id);
    await pool.acquire(createOwner('sixth'));

    expect(first.cool).not.toHaveBeenCalled();
    expect(second.cool).toHaveBeenCalledTimes(1);
  });
});
