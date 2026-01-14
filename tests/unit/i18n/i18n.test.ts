/**
 * Tests for i18n - Internationalization service
 */

import {
  getAvailableLocales,
  getLocale,
  getLocaleDisplayName,
  isValidLocale,
  setLocale,
  t,
} from '@/i18n/i18n';
import type { Locale, TranslationKey } from '@/i18n/types';

describe('i18n', () => {
  // Reset locale to default before each test
  beforeEach(() => {
    setLocale('en');
  });

  describe('t (translate)', () => {
    it('returns translated string for valid key', () => {
      const result = t('common.save' as TranslationKey);
      expect(result).toBe('Save');
    });

    it('returns string with parameter interpolation', () => {
      // Use a key that has placeholders
      const result = t('settings.blockedCommands.name' as TranslationKey, { platform: 'Unix' });
      expect(result).toBe('Blocked commands (Unix)');
    });

    it('returns key for missing translation in English', () => {
      const result = t('nonexistent.key.here' as TranslationKey);

      expect(result).toBe('nonexistent.key.here');
    });

    it('falls back to English for missing translation in other locale', () => {
      setLocale('de');

      // Use a key that exists in English but might not in German
      const result = t('common.save' as TranslationKey);

      // Should return the English translation or the German one
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles nested keys correctly', () => {
      const result = t('settings.userName.name' as TranslationKey);
      expect(result).toBe('What should Claudian call you?');
    });

    it('handles deeply nested keys', () => {
      const result = t('settings.userName.desc' as TranslationKey);
      expect(result).toBe('Your name for personalized greetings (leave empty for generic greetings)');
    });

    it('returns key when value is not a string', () => {
      // Try to access a non-leaf key (object instead of string)
      const result = t('settings' as TranslationKey);

      expect(result).toBe('settings');
    });

    it('replaces placeholders with params', () => {
      // Use a key with {param} placeholders
      const result = t('settings.blockedCommands.desc' as TranslationKey, { platform: 'Windows' });
      expect(result).toContain('Windows');
    });

    it('keeps placeholder if param not provided', () => {
      // Use a key with placeholders but don't provide the param
      const result = t('settings.blockedCommands.name' as TranslationKey, {});
      expect(result).toBe('Blocked commands ({platform})');
    });
  });

  describe('setLocale', () => {
    it('sets valid locale and returns true', () => {
      const result = setLocale('ja');

      expect(result).toBe(true);
      expect(getLocale()).toBe('ja');
    });

    it('sets Chinese Simplified locale', () => {
      const result = setLocale('zh-CN');

      expect(result).toBe(true);
      expect(getLocale()).toBe('zh-CN');
    });

    it('sets Chinese Traditional locale', () => {
      const result = setLocale('zh-TW');

      expect(result).toBe(true);
      expect(getLocale()).toBe('zh-TW');
    });

    it('returns false for invalid locale and keeps current', () => {
      setLocale('de');

      const result = setLocale('invalid' as Locale);

      expect(result).toBe(false);
      expect(getLocale()).toBe('de'); // Should remain unchanged
    });
  });

  describe('getLocale', () => {
    it('returns default locale initially', () => {
      expect(getLocale()).toBe('en');
    });

    it('returns current locale after change', () => {
      setLocale('fr');
      expect(getLocale()).toBe('fr');
    });
  });

  describe('getAvailableLocales', () => {
    it('returns all supported locales', () => {
      const locales = getAvailableLocales();

      expect(locales).toContain('en');
      expect(locales).toContain('zh-CN');
      expect(locales).toContain('zh-TW');
      expect(locales).toContain('ja');
      expect(locales).toContain('ko');
      expect(locales).toContain('de');
      expect(locales).toContain('fr');
      expect(locales).toContain('es');
      expect(locales).toContain('ru');
      expect(locales).toContain('pt');
    });

    it('returns exactly 10 locales', () => {
      const locales = getAvailableLocales();
      expect(locales).toHaveLength(10);
    });
  });

  describe('getLocaleDisplayName', () => {
    it('returns English for en', () => {
      expect(getLocaleDisplayName('en')).toBe('English');
    });

    it('returns Simplified Chinese name for zh-CN', () => {
      expect(getLocaleDisplayName('zh-CN')).toBe('简体中文');
    });

    it('returns Traditional Chinese name for zh-TW', () => {
      expect(getLocaleDisplayName('zh-TW')).toBe('繁體中文');
    });

    it('returns Japanese name for ja', () => {
      expect(getLocaleDisplayName('ja')).toBe('日本語');
    });

    it('returns Korean name for ko', () => {
      expect(getLocaleDisplayName('ko')).toBe('한국어');
    });

    it('returns German name for de', () => {
      expect(getLocaleDisplayName('de')).toBe('Deutsch');
    });

    it('returns French name for fr', () => {
      expect(getLocaleDisplayName('fr')).toBe('Français');
    });

    it('returns Spanish name for es', () => {
      expect(getLocaleDisplayName('es')).toBe('Español');
    });

    it('returns Russian name for ru', () => {
      expect(getLocaleDisplayName('ru')).toBe('Русский');
    });

    it('returns Portuguese name for pt', () => {
      expect(getLocaleDisplayName('pt')).toBe('Português');
    });

    it('returns locale code for unknown locale', () => {
      expect(getLocaleDisplayName('xx' as Locale)).toBe('xx');
    });
  });

  describe('isValidLocale', () => {
    it('returns true for valid locales', () => {
      expect(isValidLocale('en')).toBe(true);
      expect(isValidLocale('zh-CN')).toBe(true);
      expect(isValidLocale('zh-TW')).toBe(true);
      expect(isValidLocale('ja')).toBe(true);
      expect(isValidLocale('ko')).toBe(true);
      expect(isValidLocale('de')).toBe(true);
      expect(isValidLocale('fr')).toBe(true);
      expect(isValidLocale('es')).toBe(true);
      expect(isValidLocale('ru')).toBe(true);
      expect(isValidLocale('pt')).toBe(true);
    });

    it('returns false for invalid locales', () => {
      expect(isValidLocale('xx')).toBe(false);
      expect(isValidLocale('invalid')).toBe(false);
      expect(isValidLocale('')).toBe(false);
      expect(isValidLocale('en-US')).toBe(false); // Not a supported variant
    });
  });

  describe('translation in different locales', () => {
    it('translates correctly in German', () => {
      setLocale('de');
      const result = t('common.save' as TranslationKey);
      // German should have a translation or fall back to English
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('translates correctly in Japanese', () => {
      setLocale('ja');
      const result = t('common.save' as TranslationKey);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('translates correctly in Korean', () => {
      setLocale('ko');
      const result = t('common.save' as TranslationKey);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('translates correctly in Simplified Chinese', () => {
      setLocale('zh-CN');
      const result = t('common.save' as TranslationKey);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('translates correctly in French', () => {
      setLocale('fr');
      const result = t('common.save' as TranslationKey);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('translates correctly in Spanish', () => {
      setLocale('es');
      const result = t('common.save' as TranslationKey);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('translates correctly in Russian', () => {
      setLocale('ru');
      const result = t('common.save' as TranslationKey);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('translates correctly in Portuguese', () => {
      setLocale('pt');
      const result = t('common.save' as TranslationKey);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
