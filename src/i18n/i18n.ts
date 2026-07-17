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
  const dict = translations[currentLocale] ?? en;

  const keys = key.split('.');
  let value: unknown = dict;

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = (value as Record<string, unknown>)[k];
    } else {
      if (currentLocale !== DEFAULT_LOCALE) {
        return tFallback(key, params);
      }
      return key;
    }
  }

  if (typeof value !== 'string') {
    return key;
  }

  if (params) {
    return value.replace(/\{(\w+)\}/g, (match: string, param: string): string => {
      const replacement = params[param];
      return replacement !== undefined ? `${replacement}` : match;
    });
  }

  return value;
}

function tFallback(key: TranslationKey, params?: Record<string, string | number>): string {
  const dict = en;
  const keys = key.split('.');
  let value: unknown = dict;

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = (value as Record<string, unknown>)[k];
    } else {
      return key;
    }
  }

  if (typeof value !== 'string') {
    return key;
  }

  if (params) {
    return value.replace(/\{(\w+)\}/g, (match: string, param: string): string => {
      const replacement = params[param];
      return replacement !== undefined ? `${replacement}` : match;
    });
  }

  return value;
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
 * Get the current locale
 */
export function getLocale(): Locale {
  return currentLocale;
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
