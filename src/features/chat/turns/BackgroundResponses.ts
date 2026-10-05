import type { ProviderBackgroundOutputEvent, ProviderSessionEvent } from '@/core/execution';
import {
  type BackgroundTurnRenderHost,
  type BackgroundTurnRenderTarget,
  discardBackgroundTurn,
  renderAutoTriggeredTurn,
  reserveBackgroundTurn,
} from '@/features/chat/turns/BackgroundTurnRenderer';

interface BackgroundResponse {
  readonly events: ProviderBackgroundOutputEvent[];
  readonly target?: BackgroundTurnRenderTarget;
}

/** Reserves transcript order at admission, then renders only the owning session's buffered output. */
export class BackgroundResponses {
  readonly #owners = new Map<string, Map<string, BackgroundResponse>>();

  constructor(private readonly host: BackgroundTurnRenderHost) {}

  reserve(owner: string, turnId: string): void {
    let turns = this.#owners.get(owner);
    if (!turns) this.#owners.set(owner, turns = new Map<string, BackgroundResponse>());
    if (turns.has(turnId)) return;
    turns.set(turnId, {
      events: [],
      target: this.host.isConnected() ? reserveBackgroundTurn(this.host) : undefined,
    });
  }

  /** Undefined means no response completed; false means completion without visible output. */
  async handle(owner: string, event: ProviderSessionEvent, isCurrent: () => boolean): Promise<boolean | undefined> {
    if (!isCurrent()) {
      this.discard(owner);
      return undefined;
    }
    if (event.scope.kind !== 'background' || event.type === 'background_turn_started') return undefined;
    const turns = this.#owners.get(owner);
    const response = turns?.get(event.scope.turnId);
    if (!response) return undefined;
    if (event.type !== 'background_turn_completed') {
      response.events.push(event as ProviderBackgroundOutputEvent);
      return undefined;
    }
    turns!.delete(event.scope.turnId);
    if (!turns!.size) this.#owners.delete(owner);
    return renderAutoTriggeredTurn(this.host, {
      events: response.events,
      target: response.target,
      metadata: { assistantMessageId: event.nativeAssistantId },
    }, isCurrent);
  }

  discard(owner?: string): void {
    const owners = owner === undefined ? [...this.#owners.keys()] : [owner];
    for (const id of owners) {
      for (const response of this.#owners.get(id)?.values() ?? []) {
        if (response.target) discardBackgroundTurn(this.host.state, response.target);
      }
      this.#owners.delete(id);
    }
  }
}
