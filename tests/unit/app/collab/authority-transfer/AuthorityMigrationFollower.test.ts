import { AuthorityMigrationFollower } from '@/app/collab/authority-transfer/AuthorityMigrationFollower';
import { CollabError } from '@/core/collab/ClaudianCollabError';

describe('AuthorityMigrationFollower', () => {
  it('does not repeatedly retry a proof failure, but accepts a later recovery hint', async () => {
    jest.useFakeTimers();
    const follow = jest.fn().mockRejectedValue(new CollabError({ code: 'durable-progress-recovery-required' }));
    const follower = new AuthorityMigrationFollower({ follow });
    follower.notify('project-one');
    await jest.advanceTimersByTimeAsync(29_000);
    expect(follow).toHaveBeenCalledTimes(1);
    follower.notify('project-one');
    await jest.advanceTimersByTimeAsync(0);
    expect(follow).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    follower.notify('project-one');
    await jest.advanceTimersByTimeAsync(0);
    expect(follow).toHaveBeenCalledTimes(2);
    await follower.close();
  });

  afterEach(() => jest.useRealTimers());

  it('defers hints outside the caller and coalesces them while one transition settles', async () => {
    jest.useFakeTimers();
    const settled: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const follower = new AuthorityMigrationFollower({
      follow: async projectId => { await gate; settled.push(projectId); return { kind: 'completed' }; },
    });
    follower.notify('project-one');
    follower.notify('project-one');
    expect(settled).toEqual([]);
    await jest.advanceTimersByTimeAsync(0);
    follower.notify('project-one');
    release();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(settled).toEqual(['project-one']);
    await follower.close();
  });

  it('bounds failure retries and closes queued work', async () => {
    jest.useFakeTimers();
    const attempted: string[] = [];
    const follower = new AuthorityMigrationFollower({
      follow: async projectId => { attempted.push(projectId); throw new Error('offline'); },
    });
    follower.notify('project-one');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(attempted).toEqual(['project-one', 'project-one', 'project-one']);
    follower.notify('project-two');
    follower.beginClose();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(attempted).not.toContain('project-two');
    await follower.close();
  });

  it('aborts and drains an admitted transition on close', async () => {
    jest.useFakeTimers();
    let release!: () => void;
    let signal: AbortSignal | undefined;
    let closed = false;
    const follower = new AuthorityMigrationFollower({
      follow: async (_projectId, options) => {
        signal = options.signal;
        await new Promise<void>(resolve => { release = resolve; });
        return { kind: 'completed' };
      },
    });
    follower.notify('project-one');
    await jest.advanceTimersByTimeAsync(0);
    const closing = follower.close().then(() => { closed = true; });
    expect(signal?.aborted).toBe(true);
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
  });
});
