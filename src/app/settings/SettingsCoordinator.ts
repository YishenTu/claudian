export type SettingsMutation<T extends object> = (
  settings: T,
) => void | Promise<void>;

export type SettingsCommit<T extends object> = (
  settings: T,
) => void | Promise<void>;

export type ConditionalSettingsMutation<T extends object> = (
  settings: T,
) => boolean | Promise<boolean>;

export class SettingsPostCommitError extends Error {
  readonly committed = true;
  readonly phase = 'post-commit';

  constructor(readonly cause: unknown) {
    super('Settings were persisted, but post-commit publication failed.');
    this.name = 'SettingsPostCommitError';
  }
}

function restoreSettings<T extends object>(settings: T, snapshot: T): void {
  const target = settings as Record<string, unknown>;
  const source = snapshot as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      delete target[key];
    }
  }
  Object.assign(target, source);
}

export class SettingsCoordinator<T extends object> {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: T,
    private readonly persist: (settings: T) => Promise<void>,
  ) {}

  mutate(
    mutation: SettingsMutation<T>,
    onCommitted?: SettingsCommit<T>,
  ): Promise<void> {
    return this.enqueueTransactional(async () => {
      await mutation(this.settings);
      await this.persist(this.settings);
    }, onCommitted);
  }

  mutateConditionally(mutation: ConditionalSettingsMutation<T>): Promise<void> {
    return this.enqueueTransactional(async () => {
      if (await mutation(this.settings)) {
        await this.persist(this.settings);
      }
    });
  }

  persistCurrent(): Promise<void> {
    return this.enqueue(() => this.persist(this.settings));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private enqueueTransactional(
    operation: () => Promise<void>,
    onCommitted?: SettingsCommit<T>,
  ): Promise<void> {
    return this.enqueue(async () => {
      const snapshot = structuredClone(this.settings);
      try {
        await operation();
      } catch (error) {
        restoreSettings(this.settings, snapshot);
        throw error;
      }
      try {
        await onCommitted?.(this.settings);
      } catch (error) {
        throw new SettingsPostCommitError(error);
      }
    });
  }
}
