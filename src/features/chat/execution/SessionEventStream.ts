import type { ProviderSessionEvent } from '@/core/execution';

import { withExecutionUsageModel } from './usageModel';

/** One native session's ordered event and background-turn identity, reset with that session. */
export class SessionEventStream {
  #sequence = 0;
  readonly #background = new Map<string, { sequence: number; model: string | undefined }>();
  readonly #completed = new Set<string>();

  constructor(private readonly sessionInstanceId: string) {}

  get hasBackgroundWork(): boolean {
    return this.#background.size > 0;
  }

  hasBackgroundTurn(turnId: string): boolean {
    return this.#background.has(turnId);
  }

  endBackgroundTurns(): void {
    for (const turnId of this.#background.keys()) this.#completed.add(turnId);
    this.#background.clear();
  }

  accept(event: ProviderSessionEvent, model: string | undefined): ProviderSessionEvent | null {
    if (event.scope.sessionInstanceId !== this.sessionInstanceId) return null;
    let originModel: string | undefined;
    if (event.scope.kind === 'background') {
      const { turnId, sequence } = event.scope;
      const previous = this.#background.get(turnId);
      if (event.type === 'background_turn_started') {
        if (previous || this.#completed.has(turnId) || sequence <= 0) return null;
        this.#background.set(turnId, { sequence, model });
        originModel = model;
      } else {
        if (!previous || sequence <= previous.sequence) return null;
        previous.sequence = sequence;
        originModel = previous.model;
        if (event.type === 'background_turn_completed') {
          this.#background.delete(turnId);
          this.#completed.add(turnId);
        }
      }
    } else {
      if (event.scope.sequence <= this.#sequence) return null;
      this.#sequence = event.scope.sequence;
    }
    return withExecutionUsageModel(event, originModel);
  }
}
