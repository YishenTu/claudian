// @test-ci {"inputs":["src/i18n/locales/**/*.json"]}
import { createRequire } from 'node:module';

import {
  getLocaleDisplayName,
  setLocale,
  t,
} from '@/i18n/i18n';
import type * as GermanDictionary from '@/i18n/locales/de.json';

// The production lazy loader uses CommonJS, so mutate that same cached dictionary.
const de = createRequire(import.meta.url)('../../../src/i18n/locales/de.json') as typeof GermanDictionary;
import type { Locale, TranslationKey } from '@/i18n/types';

describe('i18n', () => {
  beforeEach(() => { setLocale('en'); });
  afterEach(() => { setLocale('en'); });

  // Exercise each lazy dictionary loader with an actual translation. Returning
  // an untranslated key or the English fallback must not count as success.
  it.each<[Locale, string]>([
    ['en', 'Delete'],
    ['zh-CN', '删除'],
    ['zh-TW', '刪除'],
    ['ja', '削除'],
    ['ko', '삭제'],
    ['de', 'Löschen'],
    ['fr', 'Supprimer'],
    ['es', 'Eliminar'],
    ['ru', 'Удалить'],
    ['pt', 'Excluir'],
  ])('loads and selects the %s dictionary', (locale, expected) => {
    expect(setLocale(locale)).toBe(true);
    expect(t('common.delete')).toBe(expected);
  });

  it.each(['invalid', 'constructor', 'toString', '__proto__'])(
    'keeps the current dictionary when the invalid locale %s is requested',
    invalidLocale => {
      setLocale('de');
      expect(setLocale(invalidLocale as Locale)).toBe(false);
      expect(t('common.save')).toBe('Speichern');
    },
  );

  it('interpolates numeric and string parameters', () => {
    expect(t('chat.rewind.notice', { count: 2 })).toBe('Rewound: 2 file(s) reverted');
    expect(t('chat.fork.failed', { error: 'Network timeout' })).toBe('Fork failed: Network timeout');
  });

  it.each([
    [{}, 'Rewound: 2 file(s) reverted'],
    [{ notice: {} }, 'chat.rewind.notice'],
  ])('preserves fallback semantics for localized entries: %j', (rewind, expected) => {
    const original = de.chat.rewind;
    de.chat.rewind = rewind as typeof de.chat.rewind;
    try {
      setLocale('de');
      expect(t('chat.rewind.notice', { count: 2 })).toBe(expected);
    } finally {
      de.chat.rewind = original;
    }
  });

  it('keeps placeholders whose parameters are missing', () => {
    expect(t('chat.rewind.notice', {})).toBe('Rewound: {count} file(s) reverted');
  });

  it('resolves nested keys', () => {
    expect(t('settings.userName.name')).toBe('What should Claudian call you?');
  });

  it.each<Locale>(['en', 'de'])('returns an unknown key in %s', locale => {
    setLocale(locale);
    expect(t('nonexistent.key.here' as TranslationKey)).toBe('nonexistent.key.here');
  });

  it('returns the key for a non-string dictionary entry', () => {
    expect(t('settings' as TranslationKey)).toBe('settings');
  });

  it.each<[string, string]>([
    ['de', 'Deutsch'],
    ['xx', 'xx'],
    ['constructor', 'constructor'],
    ['toString', 'toString'],
    ['__proto__', '__proto__'],
  ])('resolves the display name or falls back to the locale code for %s', (locale, expected) => {
    expect(getLocaleDisplayName(locale as Locale)).toBe(expected);
  });
});
