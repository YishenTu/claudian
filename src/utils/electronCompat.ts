function isAbortSignalLike(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as Record<string, unknown>;

  return typeof t.aborted === 'boolean' &&
    typeof t.addEventListener === 'function' &&
    typeof t.removeEventListener === 'function';
}

type PatchableSetMaxListeners = ((...args: unknown[]) => unknown) & {
  __electronPatched?: boolean;
};

type EventsModule = {
  setMaxListeners: PatchableSetMaxListeners;
};

/**
 * In Obsidian's Electron renderer, `new AbortController()` creates a browser-realm
 * AbortSignal that lacks Node.js's internal `kIsEventTarget` symbol. The SDK calls
 * `events.setMaxListeners(n, signal)` which throws because Node.js doesn't recognize
 * the browser AbortSignal as a valid EventTarget.
 *
 * Since setMaxListeners on AbortSignal only suppresses MaxListenersExceededWarning,
 * silently catching the error is safe.
 *
 * See: #143, #239, #284, #339, #342, #370, #374, #387
 */
export function patchSetMaxListenersForElectron(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Patch the shared CommonJS events module before SDK imports run.
  const events = require('events') as EventsModule;

  if (events.setMaxListeners.__electronPatched) return;

  const original = events.setMaxListeners;

  const patched: PatchableSetMaxListeners = function patchedSetMaxListeners(this: unknown, ...args: unknown[]): unknown {
    try {
      return Reflect.apply(original, this, args);
    } catch (error) {
      // Only swallow the Electron cross-realm AbortSignal error.
      // Duck-type check avoids depending on Node.js internal error message text.
      const eventTargets = args.slice(1);
      if (eventTargets.length > 0 && eventTargets.every(isAbortSignalLike)) {
        return;
      }
      throw error;
    }
  };
  patched.__electronPatched = true;

  events.setMaxListeners = patched;
}
