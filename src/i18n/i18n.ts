/**
 * i18n - Internationalization service for Claudian
 *
 * Provides translation functionality for all UI strings.
 * Supports 10 locales with English as the default fallback.
 */

import * as en from './locales/en.json';
import type { Locale, TranslationKey } from './types';

type TranslationDictionary = typeof en;

const AVAILABLE_LOCALES: readonly Locale[] = [
  'en',
  'zh-CN',
  'zh-TW',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
  'ru',
  'pt',
];

const translations: Partial<Record<Locale, TranslationDictionary>> = { en };

function loadTranslation(locale: Locale): TranslationDictionary | undefined {
  switch (locale) {
    case 'en':
      return en;
    case 'zh-CN':
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep bundled locale initialization lazy.
      return require('./locales/zh-CN.json') as TranslationDictionary;
    case 'zh-TW':
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep bundled locale initialization lazy.
      return require('./locales/zh-TW.json') as TranslationDictionary;
    case 'ja':
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep bundled locale initialization lazy.
      return require('./locales/ja.json') as TranslationDictionary;
    case 'ko':
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep bundled locale initialization lazy.
      return require('./locales/ko.json') as TranslationDictionary;
    case 'de':
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep bundled locale initialization lazy.
      return require('./locales/de.json') as TranslationDictionary;
    case 'fr':
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep bundled locale initialization lazy.
      return require('./locales/fr.json') as TranslationDictionary;
    case 'es':
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep bundled locale initialization lazy.
      return require('./locales/es.json') as TranslationDictionary;
    case 'ru':
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep bundled locale initialization lazy.
      return require('./locales/ru.json') as TranslationDictionary;
    case 'pt':
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep bundled locale initialization lazy.
      return require('./locales/pt.json') as TranslationDictionary;
    default:
      return undefined;
  }
}

const DEFAULT_LOCALE: Locale = 'en';
let currentLocale: Locale = DEFAULT_LOCALE;

/**
 * Get a translation by key with optional parameters
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  let value = lookupTranslation(translations[currentLocale] ?? en, key);
  if (value === undefined && currentLocale !== DEFAULT_LOCALE) value = lookupTranslation(en, key);
  if (typeof value !== 'string') return key;
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (match: string, param: string): string => {
    const replacement = params[param];
    return replacement !== undefined ? `${replacement}` : match;
  });
}

/** Undefined means a missing path; null means a present non-string entry. */
function lookupTranslation(dictionary: TranslationDictionary, key: TranslationKey): string | null | undefined {
  let value: unknown = dictionary;
  for (const segment of key.split('.')) {
    if (!value || typeof value !== 'object' || !(segment in value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === 'string' ? value : null;
}

/**
 * Set the current locale
 * @returns true if locale was set successfully, false if locale is invalid
 */
export function setLocale(locale: Locale): boolean {
  const translation = translations[locale] ?? loadTranslation(locale);
  if (!translation) {
    return false;
  }
  translations[locale] = translation;
  currentLocale = locale;
  return true;
}

/**
 * Get all available locales
 */
export function getAvailableLocales(): Locale[] {
  return [...AVAILABLE_LOCALES];
}

/**
 * Get display name for a locale
 */
export function getLocaleDisplayName(locale: Locale): string {
  const names: Record<Locale, string> = {
    'en': 'English',
    'zh-CN': '简体中文',
    'zh-TW': '繁體中文',
    'ja': '日本語',
    'ko': '한국어',
    'de': 'Deutsch',
    'fr': 'Français',
    'es': 'Español',
    'ru': 'Русский',
    'pt': 'Português',
  };
  return names[locale] || locale;
}
