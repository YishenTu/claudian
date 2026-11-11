/**
 * The single native process owner of an ACP session: one startup at a time, shared by concurrent
 * callers, and a shutdown that also stops whatever an in-flight startup installs. Launch, reuse and
 * cancellation policy stay with the provider.
 */
export class ACPNativeOwnerSlot<TOwner> {
  #owner: TOwner | null = null;
  #startup: Promise<TOwner> | null = null;

  /**
   * `release` stops an owner's process; `wasCurrent` is true only on the call that detached it, so
   * owner-scoped listeners are released once. It may run more than once per owner.
   */
  constructor(private readonly release: (owner: TOwner, wasCurrent: boolean) => Promise<void>) {}

  get current(): TOwner | null {
    return this.#owner;
  }

  isCurrent(owner: TOwner): boolean {
    return this.#owner === owner;
  }

  /** Makes a starting owner current, so shutdown and staleness checks see it before startup finishes. */
  install(owner: TOwner): void {
    this.#owner = owner;
  }

  /** Reuses the current owner when no startup is pending and `reusable` accepts it; otherwise joins or begins `start`. */
  ensure(reusable: (owner: TOwner) => boolean, start: () => Promise<TOwner>): Promise<TOwner> {
    const owner = this.#owner;
    if (!this.#startup && owner && reusable(owner)) return Promise.resolve(owner);
    let startup = this.#startup;
    if (!startup) {
      startup = start();
      this.#startup = startup;
      const clear = (): void => { if (this.#startup === startup) this.#startup = null; };
      startup.then(clear, clear);
    }
    return startup;
  }

  /** Detaches `owner` if it is current and stops its process. */
  detach(owner: TOwner): Promise<void> {
    const wasCurrent = this.#owner === owner;
    if (wasCurrent) this.#owner = null;
    return this.release(owner, wasCurrent);
  }

  /** Stops the current owner, waits for a pending startup, then stops what it installed; rethrows the first stop failure. */
  async shutdown(): Promise<void> {
    const startup = this.#startup;
    const failures: unknown[] = [];
    const stop = (target: TOwner | null): Promise<void> | undefined =>
      target ? this.detach(target).catch((error: unknown) => { failures.push(error); }) : undefined;
    await stop(this.#owner);
    // The startup's caller receives its own failure.
    if (startup) await startup.catch(() => undefined);
    await stop(this.#owner);
    if (failures.length > 0) {
      const [failure] = failures;
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
  }
}
