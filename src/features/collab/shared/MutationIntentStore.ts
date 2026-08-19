let nextMutationIntent = 0;

interface MutationIntent {
  readonly id: string;
  readonly identity: string | undefined;
}

export class MutationIntentStore<Key> {
  private readonly intents = new Map<Key, MutationIntent>();

  clear(key: Key, intentId: string | undefined): void {
    if (this.intents.get(key)?.id === intentId) this.intents.delete(key);
  }

  clearAll(): void {
    this.intents.clear();
  }

  discard(key: Key): void {
    this.intents.delete(key);
  }

  intent(key: Key, input: unknown): string {
    const identity = JSON.stringify(input);
    const current = this.intents.get(key);
    if (current?.identity === identity) return current.id;

    nextMutationIntent += 1;
    const intent = {
      id: `mutation${Date.now().toString(36)}_${nextMutationIntent.toString(36)}`,
      identity,
    };
    this.intents.set(key, intent);
    return intent.id;
  }
}
