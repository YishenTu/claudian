export type SettingsMutation<T extends object> = (
  settings: T,
) => void | Promise<void>;

export type ConditionalSettingsMutation<T extends object> = (
  settings: T,
) => boolean | Promise<boolean>;

export class SettingsCoordinator<T extends object> {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: T,
    private readonly persist: (settings: T) => Promise<void>,
  ) {}

  mutate(mutation: SettingsMutation<T>): Promise<void> {
    return this.enqueue(async () => {
      await mutation(this.settings);
      await this.persist(this.settings);
    });
  }

  mutateConditionally(mutation: ConditionalSettingsMutation<T>): Promise<void> {
    return this.enqueue(async () => {
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
}
