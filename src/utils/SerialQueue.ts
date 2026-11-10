/**
 * Runs operations one at a time in submission order. A failed operation rejects only its own
 * result; the next operation still runs.
 */
export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Resolves once every operation submitted so far has settled; never rejects. */
  settled(): Promise<void> {
    return this.#tail;
  }
}
