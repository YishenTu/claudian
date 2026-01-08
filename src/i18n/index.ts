/**
 * i18n - Internationalization Module
 *
 * Central entry point for all internationalization functionality
 */

// Types
export type { LocaleInfo } from './constants';
export type { Locale, TranslationKey } from './types';

// Core i18n functions
export {
  getAvailableLocales,
  getLocale,
  getLocaleDisplayName,
  isValidLocale,
  loadExternalTranslations,
  setLocale,
  t,
} from './i18n';

// Constants and utilities
export {
  COMMON_KEYS,
  DEFAULT_LOCALE,
  getFontFamily,
  getLocaleDisplayString,
  getLocaleGroup,
  getLocaleInfo,
  getLocalesForDropdown,
  isRTL,
  isValidLocaleCode,
  LANGUAGE_FAMILIES,
  LOCALE_GROUPS,
  LOCALE_REGIONS,
  SUPPORTED_LOCALES,
} from './constants';
