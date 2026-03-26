function isAbortSignalLike(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as Record<string, unknown>;

  return typeof t.aborted === 'boolean' &&
    typeof t.addEventListener === 'function' &&
    typeof t.removeEventListener === 'function';
}

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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const events = require('events');

  if (events.setMaxListeners.__electronPatched) return;

  const original = events.setMaxListeners;

  const patched = function patchedSetMaxListeners(...args: unknown[]) {
    try {
      return original.apply(this, args);
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
