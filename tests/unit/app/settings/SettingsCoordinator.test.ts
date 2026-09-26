import {
  SettingsCoordinator,
  SettingsPostCommitError,
} from '@/app/settings/SettingsCoordinator';

describe('SettingsCoordinator', () => {
  it('serializes mutation closures over the latest in-memory settings', async () => {
    const settings: Record<string, unknown> = { alpha: 0, beta: 0 };
    const persisted: Array<Record<string, unknown>> = [];
    const visibleDuringWrites: Array<Record<string, unknown>> = [];
    const coordinator = new SettingsCoordinator(settings, async (current) => {
      visibleDuringWrites.push({ ...coordinator.getCommittedSettings() });
      persisted.push({ ...current });
    });

    const first = coordinator.mutate((current) => {
      current.alpha = 1;
    });
    const second = coordinator.mutate((current) => {
      expect(current.alpha).toBe(1);
      current.beta = 2;
    });
    await Promise.all([first, second]);

    expect(settings).toEqual({ alpha: 1, beta: 2 });
    expect(coordinator.getCommittedSettings()).toEqual(settings);
    expect(visibleDuringWrites).toEqual([
      { alpha: 0, beta: 0 },
      { alpha: 1, beta: 0 },
    ]);
    expect(persisted).toEqual([
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
    const commit = jest.fn();
    const persist = jest.fn()
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
    const persist = jest.fn().mockResolvedValue(undefined);
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

  it('reports post-commit publication separately and keeps the durable state for queued work', async () => {
    const publicationError = new Error('publication failed');
    const settings: Record<string, unknown> = { value: 'old' };
    const persisted: string[] = [];
    const coordinator = new SettingsCoordinator(settings, async current => {
      persisted.push(String(current.value));
    });

    const first = coordinator.mutate(
      current => { current.value = 'durable'; },
      () => {
        expect(coordinator.getCommittedSettings()).toEqual({ value: 'durable' });
        throw publicationError;
      },
    );
    const second = coordinator.mutate(current => {
      expect(current.value).toBe('durable');
      current.value = 'next';
    });

    await expect(first).rejects.toMatchObject({
      cause: publicationError,
      committed: true,
      phase: 'post-commit',
    });
    await expect(first).rejects.toBeInstanceOf(SettingsPostCommitError);
    await expect(second).resolves.toBeUndefined();

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

  it('keeps conditional mutations serialized and persists only when requested', async () => {
    const settings: Record<string, unknown> = { transient: 0, persisted: 0 };
    const persisted: Array<Record<string, unknown>> = [];
    const coordinator = new SettingsCoordinator(settings, async current => {
      persisted.push({ ...current });
    });

    await coordinator.mutateConditionally(current => {
      current.transient = 1;
      expect(coordinator.getCommittedSettings()).toEqual({ transient: 0, persisted: 0 });
      return false;
    });
    expect(coordinator.getCommittedSettings()).toEqual({ transient: 1, persisted: 0 });
    await coordinator.mutateConditionally(current => {
      current.persisted = 2;
      return true;
    });

    expect(settings).toEqual({ transient: 1, persisted: 2 });
    expect(persisted).toEqual([{ transient: 1, persisted: 2 }]);
  });
});
