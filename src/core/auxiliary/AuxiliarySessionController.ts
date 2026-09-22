import type {
  ProviderExecutionRequest,
  ProviderExecutionRun,
  ProviderExecutionSessionLease,
  ProviderToolPolicy,
} from '../execution';
import type { AuxiliaryExecutionContext } from './AuxiliaryExecutionContext';
import { TextResponseCollector } from './TextResponseCollector';

export interface AuxiliaryRequest {
  readonly model?: string;
  readonly reasoning?: string | null;
  readonly prompt: string;
  readonly systemPrompt: string;
}

type AuxiliaryExecutionOwner = 'title' | 'inline-edit';

export class AuxiliarySessionController {
  private abortController: AbortController | null = null;
  private activeRun: ProviderExecutionRun | null = null;
  private cancelled = false;
  private generation = 0;
  private invalidationUnsubscribe: (() => void) | null = null;
  private lease: ProviderExecutionSessionLease | null = null;
  private releasePromise: Promise<void> | null = null;
  private resetRequired = false;

  constructor(
    private readonly context: AuxiliaryExecutionContext,
    private readonly owner: AuxiliaryExecutionOwner,
    private readonly toolPolicy: ProviderToolPolicy,
    private readonly collector = new TextResponseCollector(),
  ) {}

  get hasSession(): boolean {
    return this.lease !== null;
  }

  get requiresReset(): boolean {
    return this.resetRequired;
  }

  async startRoot(): Promise<void> {
    const generation = ++this.generation;
    this.cancelled = false;
    await this.#releaseCurrent();
    if (generation !== this.generation) {
      throw new Error('Cancelled');
    }
    this.resetRequired = false;
    const lease = this.context.lifecycleRegistry.acquire(
      this.context.backend,
      {
        interactionPort: this.context.interactionPort,
        lifecycle: 'ephemeral',
        nativePersistence: this.context.nativePersistence,
        vaultWorkingDirectory: this.context.vaultWorkingDirectory,
      },
      this.owner,
    );
    this.lease = lease;
    this.invalidationUnsubscribe = lease.onInvalidated(() => {
      if (this.lease !== lease) return;
      this.generation += 1;
      this.lease = null;
      this.invalidationUnsubscribe = null;
      this.resetRequired = true;
      this.cancelled = true;
      this.abortController?.abort();
      this.activeRun?.cancel();
      this.abortController = null;
      this.activeRun = null;
    });
  }

  async execute(request: AuxiliaryRequest): Promise<string> {
    const lease = this.lease;
    if (!lease) {
      throw new Error(
        this.cancelled
          ? 'Cancelled'
          : 'Auxiliary execution session is unavailable.',
      );
    }
    const abortController = new AbortController();
    const executionRequest: ProviderExecutionRequest = {
      configuration: {
        ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {}),
        ...(request.model ? { model: request.model } : {}),
        systemInstructions: {
          instructions: request.systemPrompt,
          kind: 'explicit',
        },
      },
      input: [{ text: request.prompt, type: 'text' }],
      signal: abortController.signal,
      toolPolicy: this.toolPolicy,
    };
    this.abortController = abortController;
    const run = lease.session.execute(executionRequest);
    this.activeRun = run;
    try {
      return await this.collector.collect(run);
    } finally {
      if (this.activeRun === run) {
        this.activeRun = null;
        this.abortController = null;
      }
    }
  }

  cancel(): void {
    this.generation += 1;
    this.cancelled = true;
    this.abortController?.abort();
    this.activeRun?.cancel();
    this.abortController = null;
    this.activeRun = null;
    const release = this.#releaseCurrent();
    // Observe fire-and-forget cleanup without replacing the promise awaited by
    // startRoot() or dispose(), which must still surface lifecycle failures.
    void release.catch(() => undefined);
  }

  reset(): void {
    this.resetRequired = false;
    this.cancel();
  }

  async dispose(): Promise<void> {
    this.generation += 1;
    this.cancelled = true;
    this.abortController?.abort();
    this.activeRun?.cancel();
    this.abortController = null;
    this.activeRun = null;
    await this.#releaseCurrent();
  }

  #releaseCurrent(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    const lease = this.lease;
    this.lease = null;
    this.invalidationUnsubscribe?.();
    this.invalidationUnsubscribe = null;
    if (!lease) return Promise.resolve();
    const release = lease.release().finally(() => {
      if (this.releasePromise === release) {
        this.releasePromise = null;
      }
    });
    this.releasePromise = release;
    return release;
  }
}
