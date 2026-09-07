export interface LatestTaskHandle {
  readonly signal: AbortSignal;
  complete(): boolean;
  isCurrent(): boolean;
}

interface ActiveTask {
  readonly controller: AbortController;
  readonly token: number;
}

/** Owns cancellation and stale-completion fencing for one disposable task lane. */
export class LatestTaskScope {
  private current: ActiveTask | null = null;
  private closed = false;
  private nextToken = 0;

  get active(): boolean {
    return this.current !== null;
  }

  start(): LatestTaskHandle {
    if (this.closed) throw new Error('LatestTaskScope is closed');
    this.cancel();
    const task: ActiveTask = {
      controller: new AbortController(),
      token: ++this.nextToken,
    };
    this.current = task;
    const isCurrent = () => (
      !this.closed
      && !task.controller.signal.aborted
      && this.current?.token === task.token
    );
    return {
      complete: () => {
        if (!isCurrent()) return false;
        this.current = null;
        return true;
      },
      isCurrent,
      signal: task.controller.signal,
    };
  }

  cancel(): void {
    const current = this.current;
    this.current = null;
    current?.controller.abort();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
  }
}
