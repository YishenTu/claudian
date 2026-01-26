// Types
export type { LocaleInfo } from './constants';
export type { Locale, TranslationKey } from './types';

// Core i18n functions
export {
  getAvailableLocales,
  getLocale,
  getLocaleDisplayName,
  setLocale,
  t,
} from './i18n';

// Constants and utilities
export {
  DEFAULT_LOCALE,
  getLocaleDisplayString,
  getLocaleInfo,
  SUPPORTED_LOCALES,
} from './constants';
