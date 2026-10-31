import { Events } from '@test/helpers/ObsidianEvents';
import type { Debouncer } from 'obsidian';

const pendingWork = new Set<() => void>();

function schedule(callback: () => void, delay: number): () => void {
  const cancel = () => { clearTimeout(timer); pendingWork.delete(cancel); };
  const timer = setTimeout(() => { pendingWork.delete(cancel); callback(); }, delay);
  pendingWork.add(cancel);
  return cancel;
}

export function resetWorkspaceTimers(): void {
  for (const cancel of pendingWork) cancel();
}

/** Models an already-ready host by default; startup fixtures explicitly pass layoutReady: false. */
export function createObsidianWorkspace(containerEl?: HTMLElement, options: { layoutReady?: boolean } = {}) {
  const events = new Events();
  let readyCallbacks: Array<() => void> | null = options.layoutReady === false ? [] : null;
  let cancelSave: (() => void) | undefined;
  const saveLayout = vi.fn(async () => {});
  const requestSaveLayout: Debouncer<[], Promise<void>> = Object.assign(vi.fn(() => {
    if (!cancelSave || !pendingWork.has(cancelSave)) cancelSave = schedule(() => saveLayout(), 1000);
    return requestSaveLayout;
  }), {
    run: vi.fn(() => {
      if (cancelSave && pendingWork.has(cancelSave)) { cancelSave(); return saveLayout(); }
    }),
    cancel: vi.fn(() => { cancelSave?.(); return requestSaveLayout; }),
  });
  const workspace = {
    containerEl,
    layoutReady: options.layoutReady !== false,
    onLayoutReady: vi.fn((callback: () => void) => {
      if (readyCallbacks === null) callback();
      else readyCallbacks.push(callback);
    }),
    saveLayout,
    requestSaveLayout,
    on: vi.fn(events.on.bind(events)),
    off: vi.fn(events.off.bind(events)),
    offref: vi.fn(events.offref.bind(events)),
    trigger(name: string, ...args: unknown[]): void {
      events.trigger(name, ...args);
      if (name === 'layout-ready' && readyCallbacks !== null) {
        const callbacks = readyCallbacks;
        readyCallbacks = null;
        workspace.layoutReady = true;
        const next = (index: number): void => {
          if (index < callbacks.length) schedule(() => {
            try { callbacks[index](); } finally { next(index + 1); }
          }, 0);
        };
        next(0);
      }
    },
    listenerCount: events.listenerCount.bind(events),
  };
  return workspace;
}
