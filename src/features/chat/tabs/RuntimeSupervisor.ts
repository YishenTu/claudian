import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';

/** Owns the concrete provider runtime attached to one tab. */
export class RuntimeSupervisor {
  constructor(private runtime: ChatRuntime | null = null) {}

  get current(): ChatRuntime | null {
    return this.runtime;
  }

  setCurrent(runtime: ChatRuntime | null): void {
    this.runtime = runtime;
  }

  cleanup(): void {
    const runtime = this.runtime;
    runtime?.cleanup();
    if (this.runtime === runtime) {
      this.runtime = null;
    }
  }
}
