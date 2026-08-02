import { normalizeHostnameStringMap } from '@/core/providers/settings/HostnameStringMap';
import { migrateLegacyHostnameKeyedMap } from '@/utils/env';

describe('normalizeHostnameStringMap', () => {
  it.each([null, undefined, 'path', 1, true, []])(
    'rejects non-map input %p',
    (value) => {
      expect(normalizeHostnameStringMap(value)).toEqual({});
    },
  );

  it('retains only non-empty strings with normalized keys and values', () => {
    expect(normalizeHostnameStringMap({
      ' device:a ': ' /bin/provider ',
      empty: '  ',
      number: 42,
      object: { path: '/bin/other' },
    })).toEqual({
      'device:a': '/bin/provider',
    });
  });

  it('returns a fresh map containing only safely-owned persisted entries', () => {
    const persisted = Object.create({ inherited: '/bin/inherited' }) as Record<string, unknown>;
    Object.defineProperty(persisted, 'device:a', {
      enumerable: true,
      value: '/bin/provider',
    });
    Object.defineProperty(persisted, '__proto__', {
      enumerable: true,
      value: '/bin/prototype-name',
    });

    const normalized = normalizeHostnameStringMap(persisted);

    expect(normalized).not.toBe(persisted);
    expect(normalized['device:a']).toBe('/bin/provider');
    expect(normalized.__proto__).toBe('/bin/prototype-name');
    expect(Object.keys(normalized)).toEqual(['device:a', '__proto__']);
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(normalized, '__proto__')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(normalized, 'inherited')).toBe(false);
  });

  it('composes with legacy-hostname migration without changing its precedence', () => {
    const persisted: Record<string, unknown> = {
      'legacy-host': '/legacy/provider',
      'device:current': '/current/provider',
    };
    Object.defineProperty(persisted, '__proto__', {
      enumerable: true,
      value: '/bin/prototype-name',
    });
    const normalized = normalizeHostnameStringMap(persisted);
    const migrated = migrateLegacyHostnameKeyedMap(
      normalized,
      'device:current',
      'legacy-host',
    );

    expect(migrated['device:current']).toBe('/current/provider');
    expect(migrated.__proto__).toBe('/bin/prototype-name');
    expect(Object.keys(migrated).sort()).toEqual(['__proto__', 'device:current']);
    expect(Object.getPrototypeOf(migrated)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(migrated, '__proto__')).toBe(true);
  });
});
