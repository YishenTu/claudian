import type {
  ProviderExecutionRequest,
  ProviderExecutionRun,
  ProviderExecutionSessionLease,
  ProviderExplicitInstructionPurpose,
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

export class AuxiliarySessionController {
  private activeRun: { readonly run: ProviderExecutionRun; readonly abortController: AbortController } | null = null;
  private cancelled = false;
  private generation = 0;
  private binding: { readonly lease: ProviderExecutionSessionLease; readonly unsubscribe: () => void } | null = null;
  private releasePromise: Promise<void> | null = null;
  private resetRequired = false;

  constructor(
    private readonly context: AuxiliaryExecutionContext,
    private readonly owner: ProviderExplicitInstructionPurpose,
    private readonly toolPolicy: ProviderToolPolicy,
    private readonly collector = new TextResponseCollector(),
  ) {}

  get hasSession(): boolean {
    return this.binding !== null;
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
        workingDirectory: this.context.workingDirectory,
      },
      this.owner,
    );
    const unsubscribe = lease.onInvalidated(() => {
      if (this.binding?.lease !== lease) return;
      this.binding = null;
      this.resetRequired = true;
      this.#stopRun();
    });
    this.binding = { lease, unsubscribe };
  }

  async execute(request: AuxiliaryRequest): Promise<string> {
    const lease = this.binding?.lease;
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
          purpose: this.owner,
        },
      },
      input: [{ text: request.prompt, type: 'text' }],
      signal: abortController.signal,
      toolPolicy: this.toolPolicy,
    };
    const run = lease.session.execute(executionRequest);
    const active = { abortController, run };
    this.activeRun = active;
    try {
      return await this.collector.collect(run);
    } finally {
      if (this.activeRun === active) this.activeRun = null;
    }
  }

  cancel(): void {
    this.#stopRun();
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
    this.#stopRun();
    await this.#releaseCurrent();
  }

  /** Supersedes pending startup and stops the active run. */
  #stopRun(): void {
    this.generation += 1;
    this.cancelled = true;
    const active = this.activeRun;
    this.activeRun = null;
    active?.abortController.abort();
    active?.run.cancel();
  }

  #releaseCurrent(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    const binding = this.binding;
    this.binding = null;
    if (!binding) return Promise.resolve();
    binding.unsubscribe();
    const { lease } = binding;
    const release = lease.release().finally(() => {
      if (this.releasePromise === release) {
        this.releasePromise = null;
      }
    });
    this.releasePromise = release;
    return release;
  }
}
