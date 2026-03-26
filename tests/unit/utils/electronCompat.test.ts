import { patchSetMaxListenersForElectron } from '../../../src/utils/electronCompat';

describe('patchSetMaxListenersForElectron', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const events = require('events');
  let originalSetMaxListeners: typeof events.setMaxListeners;

  beforeEach(() => {
    originalSetMaxListeners = events.setMaxListeners;
  });

  afterEach(() => {
    events.setMaxListeners = originalSetMaxListeners;
  });

  it('should not throw when setMaxListeners receives a browser-like AbortSignal', () => {
    patchSetMaxListenersForElectron();

    // Simulate a browser-realm AbortSignal that lacks kIsEventTarget symbol
    const fakeSignal = { aborted: false, addEventListener: jest.fn(), removeEventListener: jest.fn() };

    expect(() => events.setMaxListeners(50, fakeSignal)).not.toThrow();
  });

  it('should still work with valid EventEmitter targets', () => {
    patchSetMaxListenersForElectron();

    const { EventEmitter } = events;
    const emitter = new EventEmitter();

    events.setMaxListeners(100, emitter);

    expect(emitter.getMaxListeners()).toBe(100);
  });

  it('should still work with Node.js AbortSignal', () => {
    patchSetMaxListenersForElectron();

    const controller = new AbortController();

    expect(() => events.setMaxListeners(50, controller.signal)).not.toThrow();
  });

  it('should still work when called without targets (sets default)', () => {
    patchSetMaxListenersForElectron();

    expect(() => events.setMaxListeners(20)).not.toThrow();
  });

  it('should re-throw errors unrelated to eventTargets', () => {
    patchSetMaxListenersForElectron();

    // Force a non-eventTargets error by passing something that triggers a different check
    const origSML = events.setMaxListeners;
    const throwingFn = Object.assign(
      (...args: unknown[]) => {
        // Simulate a different error from setMaxListeners internals
        throw new TypeError('some other TypeError');
      },
      { __electronPatched: true },
    );
    events.setMaxListeners = throwingFn;

    // Re-patch so it wraps the throwing function (reset the patched flag first)
    delete (throwingFn as unknown as Record<string, unknown>).__electronPatched;
    patchSetMaxListenersForElectron();

    expect(() => events.setMaxListeners(50)).toThrow('some other TypeError');

    // Restore
    events.setMaxListeners = origSML;
  });

  it('should still throw for non-AbortSignal invalid targets', () => {
    patchSetMaxListenersForElectron();

    expect(() => events.setMaxListeners(50, {})).toThrow(/eventTargets/);
  });

  it('should be idempotent when called multiple times', () => {
    patchSetMaxListenersForElectron();
    const firstPatched = events.setMaxListeners;

    patchSetMaxListenersForElectron();
    expect(events.setMaxListeners).toBe(firstPatched);
  });
});
