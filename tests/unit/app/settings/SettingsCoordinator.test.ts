import {
  SettingsCoordinator,
  SettingsPostCommitError,
} from '@/app/settings/SettingsCoordinator';

describe('SettingsCoordinator', () => {
  it('serializes mutation closures over the latest in-memory settings', async () => {
    const settings: Record<string, unknown> = { alpha: 0, beta: 0, obsolete: 'remove-me' };
    const persisted: Array<Record<string, unknown>> = [];
    const queuedDrafts: Array<Record<string, unknown>> = [];
    const visibleDuringWrites: Array<Record<string, unknown>> = [];
    const coordinator = new SettingsCoordinator(settings, async (current) => {
      visibleDuringWrites.push({ ...coordinator.getCommittedSettings() });
      persisted.push({ ...current });
    });

    const first = coordinator.mutate((current) => {
      current.alpha = 1;
      delete current.obsolete;
    });
    const second = coordinator.mutate((current) => {
      queuedDrafts.push({ ...current });
      current.beta = 2;
    });
    await Promise.all([first, second]);

    expect(settings).toStrictEqual({ alpha: 1, beta: 2 });
    expect(queuedDrafts).toStrictEqual([{ alpha: 1, beta: 0 }]);
    expect(coordinator.getCommittedSettings()).toEqual(settings);
    expect(visibleDuringWrites).toStrictEqual([
      { alpha: 0, beta: 0, obsolete: 'remove-me' },
      { alpha: 1, beta: 0 },
    ]);
    expect(persisted).toStrictEqual([
      { alpha: 1, beta: 0 },
      { alpha: 1, beta: 2 },
    ]);
  });

  it('publishes committed side effects before the next queued mutation starts', async () => {
    const settings: Record<string, unknown> = { value: 0 };
    const events: string[] = [];
    const coordinator = new SettingsCoordinator(settings, async () => {
      events.push('persist');
    });

    const first = coordinator.mutate(
      current => { current.value = 1; },
      () => { events.push(`commit:${coordinator.getCommittedSettings().value}`); },
    );
    const second = coordinator.mutate(current => {
      events.push(`next:${current.value}`);
    });
    await Promise.all([first, second]);

    expect(events).toEqual(['persist', 'commit:1', 'next:1', 'persist']);
  });

  it('rolls back a failed save before running later queued mutations', async () => {
    const settings: Record<string, unknown> = {
      nested: { committed: true },
    };
    const writeError = new Error('write failed');
    const commit = vi.fn();
    const persist = vi.fn()
      .mockRejectedValueOnce(writeError)
      .mockResolvedValueOnce(undefined);
    const coordinator = new SettingsCoordinator(settings, persist);

    const first = coordinator.mutate(current => {
      current.first = true;
      current.nested = { committed: false };
    }, commit);
    const second = coordinator.mutate(current => {
      expect(current).toEqual({ nested: { committed: true } });
      expect(coordinator.getCommittedSettings()).toEqual({ nested: { committed: true } });
      current.second = true;
    });

    await expect(first).rejects.toBe(writeError);
    expect(commit).not.toHaveBeenCalled();
    await expect(second).resolves.toBeUndefined();

    expect(settings).toEqual({ nested: { committed: true }, second: true });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('restores the snapshot when the mutation itself rejects', async () => {
    const originalError = new Error('mutation failed');
    const settings: Record<string, unknown> = { value: 'committed' };
    const persist = vi.fn().mockResolvedValue(undefined);
    const coordinator = new SettingsCoordinator(settings, persist);

    await expect(coordinator.mutate(async current => {
      current.value = 'partial';
      expect(coordinator.getCommittedSettings()).toEqual({ value: 'committed' });
      throw originalError;
    })).rejects.toBe(originalError);

    expect(settings).toEqual({ value: 'committed' });
    expect(coordinator.getCommittedSettings()).toEqual(settings);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([false, true])('reports post-commit publication separately and keeps the durable state for queued work (publisher rejects: %s)', async publisherRejects => {
    const publicationError = new Error('commit callback failed');
    const publisherError = new Error('publisher failed');
    const aggregateCause = expect.objectContaining({ errors: [publicationError, publisherError] });
    const settings: Record<string, unknown> = { value: 'old' };
    const persisted: string[] = [];
    const committedSnapshots: Array<Record<string, unknown>> = [];
    const queuedDrafts: Array<Record<string, unknown>> = [];
    const published: Array<Record<string, unknown>> = [];
    const coordinator = new SettingsCoordinator(settings, async current => {
      persisted.push(String(current.value));
    }, async current => {
      published.push({ ...current });
      if (publisherRejects && current.value === 'durable') throw publisherError;
    });

    const first = coordinator.mutate(
      current => { current.value = 'durable'; },
      async () => {
        committedSnapshots.push({ ...coordinator.getCommittedSettings() });
        throw publicationError;
      },
    );
    const second = coordinator.mutate(current => {
      queuedDrafts.push({ ...current });
      current.value = 'next';
    });

    await expect(first).rejects.toMatchObject({
      cause: publisherRejects ? aggregateCause : publicationError,
      committed: true,
      phase: 'post-commit',
    });
    await expect(first).rejects.toBeInstanceOf(SettingsPostCommitError);
    await expect(first).rejects.toHaveProperty('cause', expect.any(publisherRejects ? AggregateError : Error));
    await expect(second).resolves.toBeUndefined();

    expect(committedSnapshots).toEqual([{ value: 'durable' }]);
    expect(queuedDrafts).toEqual([{ value: 'durable' }]);
    expect(published).toEqual([{ value: 'durable' }, { value: 'next' }]);
    expect(settings).toEqual({ value: 'next' });
    expect(persisted).toEqual(['durable', 'next']);
  });

  it('serializes compatibility saves with mutations', async () => {
    const settings: Record<string, unknown> = { value: 1 };
    const persisted: number[] = [];
    const coordinator = new SettingsCoordinator(settings, async current => {
      persisted.push(current.value as number);
    });

    await Promise.all([
      coordinator.persistCurrent(),
      coordinator.mutate(current => { current.value = 2; }),
    ]);

    expect(persisted).toEqual([1, 2]);
  });

  it('discards rejected conditional drafts and commits accepted ones', async () => {
    const settings: Record<string, unknown> = { rejected: 0, accepted: 0 };
    const persisted: Array<Record<string, unknown>> = [];
    const published: Array<Record<string, unknown>> = [];
    const commit = vi.fn();
    const coordinator = new SettingsCoordinator(
      settings,
      async current => { persisted.push({ ...current }); },
      current => { published.push({ ...current }); },
    );

    await expect(coordinator.mutateConditionally(current => {
      current.rejected = 1;
      return false;
    }, commit)).resolves.toBeUndefined();

    expect(coordinator.getCommittedSettings()).toEqual({ rejected: 0, accepted: 0 });
    expect(persisted).toEqual([]);
    expect(published).toEqual([]);
    expect(commit).not.toHaveBeenCalled();

    await coordinator.mutateConditionally(current => {
      expect(current.rejected).toBe(0);
      current.accepted = 2;
      return true;
    }, commit);

    expect(settings).toEqual({ rejected: 0, accepted: 2 });
    expect(persisted).toEqual([{ rejected: 0, accepted: 2 }]);
    expect(published).toEqual([{ rejected: 0, accepted: 2 }]);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});


it('keeps shared settings readers on committed values throughout a failed write', async () => {
  const settings = { nested: { prompt: 'committed' } };
  const retained = settings.nested;
  let rejectWrite!: (error: Error) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const gate = new Promise<void>((_, reject) => { rejectWrite = reject; });
  const coordinator = new SettingsCoordinator(settings, () => { markStarted(); return gate; });
  const mutation = coordinator.mutate(draft => { draft.nested.prompt = 'uncommitted'; });
  const settled = mutation.catch(() => undefined);
  await started;
  try {
    expect(settings.nested.prompt).toBe('committed');
    expect(retained.prompt).toBe('committed');
  } finally {
    rejectWrite(new Error('simulated storage failure'));
    await settled;
    expect(settings.nested.prompt).toBe('committed');
  }
});
