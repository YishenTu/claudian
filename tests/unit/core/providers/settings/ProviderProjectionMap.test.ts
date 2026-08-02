import {
  ensureProviderProjectionMap,
  normalizeProviderProjectionMap,
  PROVIDER_PROJECTION_KEYS,
} from '@/core/providers/settings/ProviderProjectionMap';

describe('ProviderProjectionMap', () => {
  it('covers every supported saved provider projection key', () => {
    expect(PROVIDER_PROJECTION_KEYS).toEqual([
      'savedProviderModel',
      'savedProviderEffort',
      'savedProviderServiceTier',
      'savedProviderThinkingBudget',
      'savedProviderPermissionMode',
    ]);
  });

  it.each([null, undefined, 'model', 1, true, []])(
    'rejects non-map input %p',
    (value) => {
      expect(normalizeProviderProjectionMap(value)).toEqual({});
    },
  );

  it('preserves string values and filters mixed persisted types', () => {
    expect(normalizeProviderProjectionMap({
      claude: '',
      codex: 'gpt-test',
      grok: null,
      opencode: 42,
      pi: false,
    })).toEqual({
      claude: '',
      codex: 'gpt-test',
    });
  });

  it('returns a fresh, safely-owned object and ignores inherited values', () => {
    const persisted = Object.create({ inherited: 'bad' }) as Record<string, unknown>;
    persisted.codex = 'gpt-test';
    Object.defineProperty(persisted, '__proto__', {
      enumerable: true,
      value: 'saved-value',
    });

    const normalized = normalizeProviderProjectionMap(persisted);

    expect(normalized).not.toBe(persisted);
    expect(normalized.codex).toBe('gpt-test');
    expect(normalized.__proto__).toBe('saved-value');
    expect(Object.keys(normalized)).toEqual(['codex', '__proto__']);
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(normalized, '__proto__')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(normalized, 'inherited')).toBe(false);
  });

  it('normalizes and replaces the persisted map when ensuring ownership', () => {
    const settings: Record<string, unknown> = {
      savedProviderModel: ['array-entry'],
    };

    const ensured = ensureProviderProjectionMap(settings, 'savedProviderModel');
    ensured.codex = 'gpt-test';

    expect(settings.savedProviderModel).toBe(ensured);
    expect(settings.savedProviderModel).toEqual({ codex: 'gpt-test' });
  });
});
