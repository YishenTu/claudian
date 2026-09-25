import { getLocaleInfo } from '@/i18n/constants';

describe('i18n/constants', () => {

  it('getLocaleInfo returns metadata for a supported locale', () => {
    const info = getLocaleInfo('en');
    expect(info).toBeDefined();
    expect(info?.code).toBe('en');
  });

  it('getLocaleInfo returns undefined for unknown locale', () => {
    expect(getLocaleInfo('xx' as any)).toBeUndefined();
  });
});

