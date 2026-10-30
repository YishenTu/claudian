type WorkspaceListener = (...args: unknown[]) => void;
type WorkspaceEventRef = { name: string; callback: WorkspaceListener };

/** Workspace DOM and events only; fixtures supply the layout APIs they exercise. */
export function createObsidianWorkspace(containerEl: HTMLElement) {
  const listeners = new Map<string, Set<WorkspaceListener>>();
  return {
    containerEl,
    on: vi.fn((name: string, callback: WorkspaceListener): WorkspaceEventRef => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
      return { name, callback };
    }),
    offref: vi.fn((ref: WorkspaceEventRef) => {
      listeners.get(ref.name)?.delete(ref.callback);
    }),
    trigger(name: string, ...args: unknown[]): void {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args);
    },
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
  };
}
