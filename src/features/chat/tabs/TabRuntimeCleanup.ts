export interface TabRuntimeCleanupFailure {
  readonly error: unknown;
  readonly resource: string;
}

export type TabRuntimeCleanupTask = () => void | Promise<void>;

/** Owns teardown tasks for one tab runtime and releases them in reverse order. */
export class TabRuntimeCleanup {
  private readonly tasks: Array<{ resource: string; task: TabRuntimeCleanupTask }> = [];
  private disposal: Promise<readonly TabRuntimeCleanupFailure[]> | null = null;

  get isDisposed(): boolean {
    return this.disposal !== null;
  }

  register(resource: string, task: TabRuntimeCleanupTask): void {
    if (this.disposal) {
      throw new Error(`Cannot register ${resource} after tab runtime cleanup`);
    }
    this.tasks.push({ resource, task });
  }

  dispose(): Promise<readonly TabRuntimeCleanupFailure[]> {
    if (!this.disposal) {
      this.disposal = this.disposeTasks();
    }
    return this.disposal;
  }

  private async disposeTasks(): Promise<readonly TabRuntimeCleanupFailure[]> {
    const failures: TabRuntimeCleanupFailure[] = [];
    const tasks = this.tasks.splice(0).reverse();
    for (const { resource, task } of tasks) {
      try {
        await task();
      } catch (error) {
        failures.push({ error, resource });
      }
    }
    return failures;
  }
}
