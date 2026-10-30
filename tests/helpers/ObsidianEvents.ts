import type { EventRef } from 'obsidian';

type Callback = (...args: unknown[]) => unknown;
type Listener = EventRef & { e: Events; name: string; fn: Callback; ctx: unknown };

/** Obsidian Events dispatches a snapshot and reports callback errors asynchronously. */
export class Events {
  private listeners = new Map<string, Listener[]>();

  on(name: string, fn: Callback, ctx?: unknown): Listener {
    const listener = { e: this, name, fn, ctx };
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    return listener;
  }

  off(name: string, callback: Callback): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter(ref => ref.fn !== callback));
  }

  offref(ref: EventRef): void {
    for (const [name, listeners] of this.listeners) {
      this.listeners.set(name, listeners.filter(listener => listener !== ref));
    }
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const ref of [...(this.listeners.get(name) ?? [])]) this.tryTrigger(ref, args);
  }

  tryTrigger(ref: EventRef, args: unknown[]): void {
    if (!('fn' in ref) || typeof ref.fn !== 'function' || !('ctx' in ref)) {
      throw new Error('Expected an Obsidian Events reference');
    }
    try {
      ref.fn.apply(ref.ctx, args);
    } catch (error) {
      setTimeout(() => { throw error; }, 0);
    }
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.length, 0);
  }
}
