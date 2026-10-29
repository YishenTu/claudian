import { patchSetMaxListenersForElectron } from '../../../src/utils/electronCompat';

describe('patchSetMaxListenersForElectron', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const events = require('events');
  let originalDefaultMaxListeners: number;
  let originalSetMaxListeners: typeof events.setMaxListeners;

  beforeEach(() => {
    originalSetMaxListeners = events.setMaxListeners;
    originalDefaultMaxListeners = events.defaultMaxListeners;
  });

  afterEach(() => {
    events.setMaxListeners = originalSetMaxListeners;
    events.defaultMaxListeners = originalDefaultMaxListeners;
  });

  it('should not throw when setMaxListeners receives a browser-like AbortSignal', () => {
    patchSetMaxListenersForElectron();

    // Simulate a browser-realm AbortSignal that lacks kIsEventTarget symbol
    const fakeSignal = { aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };

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

    events.setMaxListeners(20);

    expect(events.defaultMaxListeners).toBe(20);
  });

  it('should re-throw errors unrelated to eventTargets', () => {
    patchSetMaxListenersForElectron();

    // Force a non-eventTargets error by passing something that triggers a different check
    const origSML = events.setMaxListeners;
    const throwingFn = Object.assign(
      () => {
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

  describe('invalid listener limits', () => {
    // Expected codes come from the saved unpatched native function itself
    // (Node's public events.setMaxListeners), never from internal message text.
    function nativeRejectionCode(limit: unknown, ...targets: unknown[]): string | undefined {
      try {
        originalSetMaxListeners(limit, ...targets);
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return undefined;
    }

    function patchedRejectionCode(limit: unknown, ...targets: unknown[]): string | undefined {
      try {
        events.setMaxListeners(limit, ...targets);
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return undefined;
    }

    const targetKinds: Array<[string, () => unknown]> = [
      ['genuine Node AbortSignal', () => new AbortController().signal],
      [
        'browser-like AbortSignal',
        () => ({ aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
      ],
    ];

    const invalidLimits: Array<[string, unknown, string]> = [
      ['negative limit', -1, 'ERR_OUT_OF_RANGE'],
      ['NaN limit', NaN, 'ERR_OUT_OF_RANGE'],
      ['null limit', null, 'ERR_INVALID_ARG_TYPE'],
      // A numeric-looking invalid string keeps the fixture fault-sensitive: it also
      // exposes an incorrectly coercive numeric admission guard ('1' >= 0 is truthy),
      // which a non-numeric string cannot. The native oracle rejects it as invalid-type.
      ['numeric-looking string limit', '1', 'ERR_INVALID_ARG_TYPE'],
    ];

    const invalidRows: Array<[string, unknown, string, () => unknown]> = [];
    for (const [limitLabel, limit, expectedCode] of invalidLimits) {
      for (const [targetLabel, makeTarget] of targetKinds) {
        invalidRows.push([`${limitLabel} with ${targetLabel}`, limit, expectedCode, makeTarget]);
      }
    }

    it.each(invalidRows)(
      'should preserve native rejection of an invalid listener limit (%s)',
      (_label, limit, expectedCode, makeTarget) => {
        patchSetMaxListenersForElectron();

        const oracleCode = nativeRejectionCode(limit, makeTarget());
        expect(oracleCode).toBe(expectedCode);

        expect(patchedRejectionCode(limit, makeTarget())).toBe(oracleCode);
      },
    );

    it('should not treat null as the default listener limit', () => {
      patchSetMaxListenersForElectron();

      const oracleCode = nativeRejectionCode(null);
      expect(oracleCode).toBe('ERR_INVALID_ARG_TYPE');

      const before = events.defaultMaxListeners;
      expect(patchedRejectionCode(null)).toBe(oracleCode);
      expect(events.defaultMaxListeners).toBe(before);
    });

    it.each([
      ['zero', 0],
      ['fractional', 1.5],
      ['infinite', Infinity],
      ['explicit undefined', undefined],
      ['typical browser limit', 50],
    ] as Array<[string, number | undefined]>)(
      'should keep accepting a valid limit (%s) on browser-like AbortSignals',
      (_label, limit) => {
        patchSetMaxListenersForElectron();

        const target = { aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
        const before = events.defaultMaxListeners;
        expect(() => events.setMaxListeners(limit, target)).not.toThrow();
        expect(events.defaultMaxListeners).toBe(before);
      },
    );

    it.each([
      ['zero', 0],
      ['fractional', 1.5],
      ['infinite', Infinity],
    ] as Array<[string, number]>)(
      'should keep accepting a valid limit (%s) on genuine Node AbortSignals',
      (_label, limit) => {
        patchSetMaxListenersForElectron();

        const target = new AbortController().signal;
        expect(() => events.setMaxListeners(limit, target)).not.toThrow();
      },
    );
  });
});
