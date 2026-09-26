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
  private pendingSnapshot: T | null = null;

  constructor(
    private readonly settings: T,
    private readonly persist: (settings: T) => Promise<void>,
    private readonly publish?: (settings: Readonly<T>, previous: Readonly<T>) => void | Promise<void>,
  ) {}

  /** Excludes mutations whose persistence is still pending. Callers must not mutate this view. */
  getCommittedSettings(): Readonly<T> {
    return this.pendingSnapshot ?? this.settings;
  }

  mutate(
    mutation: SettingsMutation<T>,
    onCommitted?: SettingsCommit<T>,
  ): Promise<void> {
    return this.#enqueueTransactional(async () => {
      await mutation(this.settings);
      await this.persist(this.settings);
    }, onCommitted);
  }

  mutateConditionally(mutation: ConditionalSettingsMutation<T>): Promise<void> {
    return this.#enqueueTransactional(async () => {
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

  #enqueueTransactional(
    operation: () => Promise<void>,
    onCommitted?: SettingsCommit<T>,
  ): Promise<void> {
    return this.enqueue(async () => {
      const snapshot = structuredClone(this.settings);
      this.pendingSnapshot = snapshot;
      try {
        await operation();
      } catch (error) {
        restoreSettings(this.settings, snapshot);
        throw error;
      } finally {
        this.pendingSnapshot = null;
      }
      const errors: unknown[] = [];
      try { await onCommitted?.(this.settings); } catch (error) { errors.push(error); }
      try { await this.publish?.(this.settings, snapshot); } catch (error) { errors.push(error); }
      if (errors.length > 0) {
        throw new SettingsPostCommitError(errors.length === 1 ? errors[0] : new AggregateError(errors));
      }
    });
  }
}
