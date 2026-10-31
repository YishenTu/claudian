const observers = new Set<ControlledResizeObserver>();

/** No layout engine: callbacks run only when a test supplies an entry. */
export class ControlledResizeObserver implements ResizeObserver {
  private targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element, _options?: ResizeObserverOptions): void {
    this.targets.add(target);
    observers.add(this);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
    if (!this.targets.size) observers.delete(this);
  }

  disconnect(): void {
    this.targets.clear();
    observers.delete(this);
  }

  deliver(entry: ResizeObserverEntry): void {
    if (this.targets.has(entry.target)) this.callback([entry], this);
  }
}

export function triggerResize(target: Element, entry: Omit<ResizeObserverEntry, 'target'>): void {
  for (const observer of [...observers]) observer.deliver({ ...entry, target });
}

export function resetResizeObservers(): void {
  for (const observer of observers) observer.disconnect();
}
