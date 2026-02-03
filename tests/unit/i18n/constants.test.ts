import { DEFAULT_LOCALE, getLocaleDisplayString, getLocaleInfo, SUPPORTED_LOCALES } from '@/i18n/constants';

describe('i18n/constants', () => {
  it('DEFAULT_LOCALE is en', () => {
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('getLocaleInfo returns metadata for a supported locale', () => {
    const info = getLocaleInfo('en');
    expect(info).toBeDefined();
    expect(info?.code).toBe('en');
    expect(info?.name).toBe('English');
    expect(info?.englishName).toBe('English');
    expect(info?.flag).toBe('🇺🇸');
  });

  it('getLocaleInfo returns undefined for unknown locale', () => {
    expect(getLocaleInfo('xx' as any)).toBeUndefined();
  });

  it('getLocaleDisplayString returns a string with a flag by default', () => {
    expect(getLocaleDisplayString('en')).toBe('🇺🇸 English (English)');
  });

  it('getLocaleDisplayString can omit the flag', () => {
    expect(getLocaleDisplayString('en', false)).toBe('English (English)');
  });

  it('getLocaleDisplayString returns code when locale is unknown', () => {
    expect(getLocaleDisplayString('xx' as any)).toBe('xx');
  });

  it('getLocaleDisplayString omits the flag when metadata has no flag', () => {
    const originalFlag = SUPPORTED_LOCALES[0]?.flag;
    SUPPORTED_LOCALES[0].flag = undefined;
    try {
      expect(getLocaleDisplayString('en')).toBe('English (English)');
    } finally {
      SUPPORTED_LOCALES[0].flag = originalFlag;
    }
  });
});

