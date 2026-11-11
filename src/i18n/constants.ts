/**
 * i18n Constants and Utilities
 *
 * Centralized constants for language management and UI display
 */

import type { Locale } from './types';

/**
 * Supported locales with metadata
 */
export interface LocaleInfo {
  code: Locale;
  name: string;           // Native name
  englishName: string;    // English name
}

/**
 * All supported locales with display information
 */
export const SUPPORTED_LOCALES: LocaleInfo[] = [
  { code: 'en', name: 'English', englishName: 'English' },
  { code: 'zh-CN', name: '简体中文', englishName: 'Simplified Chinese' },
  { code: 'zh-TW', name: '繁體中文', englishName: 'Traditional Chinese' },
  { code: 'ja', name: '日本語', englishName: 'Japanese' },
  { code: 'ko', name: '한국어', englishName: 'Korean' },
  { code: 'de', name: 'Deutsch', englishName: 'German' },
  { code: 'fr', name: 'Français', englishName: 'French' },
  { code: 'es', name: 'Español', englishName: 'Spanish' },
  { code: 'ru', name: 'Русский', englishName: 'Russian' },
  { code: 'pt', name: 'Português', englishName: 'Portuguese' },
];

/**
 * Default locale
 */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Get locale info by code
 */
export function getLocaleInfo(code: string): LocaleInfo | undefined {
  return SUPPORTED_LOCALES.find(locale => locale.code === code);
}
