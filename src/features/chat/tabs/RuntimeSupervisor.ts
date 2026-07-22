import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';

/** Owns the concrete provider runtime attached to one tab. */
export class RuntimeSupervisor {
  private acceptedResourceGeneration: number;
  private invalidatedResourceGeneration = 0;

  constructor(
    private runtime: ChatRuntime | null = null,
    resourceGeneration = 0,
  ) {
    this.acceptedResourceGeneration = resourceGeneration;
  }

  get current(): ChatRuntime | null {
    return this.runtime;
  }

  get isInvalidated(): boolean {
    return this.runtime !== null
      && this.acceptedResourceGeneration < this.invalidatedResourceGeneration;
  }

  setCurrent(runtime: ChatRuntime | null, resourceGeneration?: number): void {
    this.runtime = runtime;
    if (resourceGeneration !== undefined) {
      this.acceptedResourceGeneration = resourceGeneration;
    }
  }

  invalidate(resourceGeneration: number): void {
    this.invalidatedResourceGeneration = Math.max(
      this.invalidatedResourceGeneration,
      resourceGeneration,
    );
  }

  cleanup(): void {
    const runtime = this.runtime;
    runtime?.cleanup();
    if (this.runtime === runtime) {
      this.runtime = null;
    }
  }
}
