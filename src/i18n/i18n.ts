/**
 * i18n - Internationalization service for Claudian
 *
 * Provides translation functionality for all UI strings.
 * Supports 10 locales with English as the default fallback.
 */

import * as de from './locales/de.json';
// Import translation files from locales folder
import * as en from './locales/en.json';
import * as es from './locales/es.json';
import * as fr from './locales/fr.json';
import * as ja from './locales/ja.json';
import * as ko from './locales/ko.json';
import * as pt from './locales/pt.json';
import * as ru from './locales/ru.json';
import * as zhCN from './locales/zh-CN.json';
import * as zhTW from './locales/zh-TW.json';
import type { Locale, TranslationKey } from './types';

// Type-safe translation mapping
const translations: Record<Locale, typeof en> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ja,
  ko,
  de,
  fr,
  es,
  ru,
  pt,
};

// Default locale
const DEFAULT_LOCALE: Locale = 'en';

// Current locale (can be changed at runtime)
let currentLocale: Locale = DEFAULT_LOCALE;

/**
 * Get a translation by key with optional parameters
 * @param key - Dot-notation key (e.g., 'settings.userName.name')
 * @param params - Optional parameters for string interpolation
 * @returns Translated string
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const locale = currentLocale;
  const dict = translations[locale];

  // Navigate nested object using dot notation
  const keys = key.split('.');
  let value: any = dict;

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      // Fallback to English if key not found in current locale
      if (locale !== DEFAULT_LOCALE) {
        console.warn(`[i18n] Missing translation for key "${key}" in locale "${locale}", falling back to English`);
        return tFallback(key, params);
      }
      console.warn(`[i18n] Missing translation for key "${key}"`);
      return key;
    }
  }

  if (typeof value !== 'string') {
    console.warn(`[i18n] Translation for key "${key}" is not a string`);
    return key;
  }

  // Replace placeholders {param}
  if (params) {
    return value.replace(/\{(\w+)\}/g, (_, param) => {
      return params[param]?.toString() ?? `{${param}}`;
    });
  }

  return value;
}

/**
 * Fallback to English translation
 * @param key - Dot-notation translation key
 * @param params - Optional parameters for string interpolation
 * @returns English translation, or the key itself if not found
 */
function tFallback(key: TranslationKey, params?: Record<string, string | number>): string {
  const dict = translations[DEFAULT_LOCALE];
  const keys = key.split('.');
  let value: any = dict;

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      console.error(`[i18n] CRITICAL: Missing translation for key "${key}" in default locale "${DEFAULT_LOCALE}"`);
      return key;
    }
  }

  if (typeof value !== 'string') {
    console.error(`[i18n] CRITICAL: Translation for key "${key}" is not a string in default locale`);
    return key;
  }

  if (params) {
    return value.replace(/\{(\w+)\}/g, (_, param) => {
      return params[param]?.toString() ?? `{${param}}`;
    });
  }

  return value;
}

/**
 * Set the current locale
 * @returns true if locale was set successfully, false if locale is invalid
 */
export function setLocale(locale: Locale): boolean {
  if (!translations[locale]) {
    console.warn(`[i18n] Unknown locale: ${locale}, keeping current locale: ${currentLocale}`);
    return false;
  }
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
  return Object.keys(translations) as Locale[];
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

/**
 * Check if a locale exists
 */
export function isValidLocale(locale: string): locale is Locale {
  return (translations as Record<string, any>)[locale] !== undefined;
}

/**
 * Load translations from external JSON files (for future extensibility)
 * This allows adding new languages without recompiling
 */
export async function loadExternalTranslations(locale: Locale, path: string): Promise<boolean> {
  try {
    // In Obsidian plugin context, we'd use the app.vault.read()
    // For now, this is a placeholder for future extension
    console.log(`[i18n] External translation loading not yet implemented for ${locale}`);
    return false;
  } catch (error) {
    console.error(`[i18n] Failed to load external translations for ${locale}:`, error);
    return false;
  }
}
