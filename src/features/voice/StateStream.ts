// A tiny value-holding observable: subscribers receive the current value
// immediately, then every distinct change. Listener errors are isolated so a
// bad UI subscriber can never disrupt the voice turn loop. Replaces the
// Set-of-listeners + replay pattern that was hand-rolled across the voice
// feature (turn state, pending command, mute, dictation state).

export class StateStream<T> {
  private readonly listeners = new Set<(value: T) => void>();

  constructor(private value: T) {}

  get(): T {
    return this.value;
  }

  /** Update and notify listeners. No-op when the value is unchanged. */
  set(value: T): void {
    if (this.value === value) {
      return;
    }
    this.value = value;
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch {
        // A listener error must never disrupt the emitter.
      }
    }
  }

  /** Subscribe; fires immediately with the current value. Returns unsubscribe. */
  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    try {
      listener(this.value);
    } catch {
      // The immediate replay is isolated like set() — a throwing listener must
      // not break subscription wiring.
    }
    return () => {
      this.listeners.delete(listener);
    };
  }
}
