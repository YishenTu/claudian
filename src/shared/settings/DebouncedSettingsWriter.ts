/** Coalesces text drafts before they enter the host's transactional settings queue. */
export class DebouncedSettingsWriter<T> {
  private readonly pending = new Map<string, (settings: T) => void>();
  private timer: number | undefined;
  private saving = Promise.resolve(true);

  constructor(
    private readonly save: (mutation: (settings: T) => void) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  schedule(key: string, mutation: (settings: T) => void): void {
    this.pending.set(key, mutation);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.flush(); }, 500);
  }

  flush(): Promise<boolean> {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.size === 0) return this.saving;
    const mutations = [...this.pending.values()];
    this.pending.clear();
    this.saving = this.save(settings => {
      for (const mutation of mutations) mutation(settings);
    }).then(() => true, error => {
      this.onError(error);
      return false;
    });
    return this.saving;
  }
}
