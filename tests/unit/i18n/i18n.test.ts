import {
  getLocaleDisplayName,
  setLocale,
  t,
} from '@/i18n/i18n';
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

  it('keeps the current dictionary when an invalid locale is requested', () => {
    setLocale('de');
    expect(setLocale('invalid' as Locale)).toBe(false);
    expect(t('common.save')).toBe('Speichern');
  });

  it('interpolates numeric and string parameters', () => {
    expect(t('chat.rewind.notice', { count: 2 })).toBe('Rewound: 2 file(s) reverted');
    expect(t('chat.fork.failed', { error: 'Network timeout' })).toBe('Fork failed: Network timeout');
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

  it('uses the locale code for an unknown display name', () => {
    expect(getLocaleDisplayName('xx' as Locale)).toBe('xx');
  });
});
