/**
 * Electron compatibility patches.
 *
 * Must be imported before any module that uses `events.setMaxListeners`
 * with AbortSignal (e.g., @anthropic-ai/claude-agent-sdk).
 *
 * In Electron's Node.js runtime, AbortSignal is not recognized as an
 * EventTarget by the `events` module, causing:
 *   "The 'eventTargets' argument must be an instance of EventEmitter or EventTarget"
 *
 * This patches setMaxListeners to silently ignore the error for AbortSignal.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsModule = require('events');

const originalSetMaxListeners = eventsModule.setMaxListeners;
if (typeof originalSetMaxListeners === 'function') {
  eventsModule.setMaxListeners = function patchedSetMaxListeners(n: number, ...eventTargets: unknown[]) {
    try {
      return originalSetMaxListeners.call(eventsModule, n, ...eventTargets);
    } catch (error) {
      if (
        error instanceof TypeError &&
        typeof error.message === 'string' &&
        error.message.includes('eventTargets')
      ) {
        // Electron's AbortSignal doesn't extend EventTarget for the events module.
        // Silently skip — the max listener warning is non-critical.
        return;
      }
      throw error;
    }
  };
}
