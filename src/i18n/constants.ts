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
  flag?: string;          // Optional flag emoji
}

/**
 * All supported locales with display information
 */
export const SUPPORTED_LOCALES: LocaleInfo[] = [
  { code: 'en', name: 'English', englishName: 'English', flag: '🇺🇸' },
  { code: 'zh-CN', name: '简体中文', englishName: 'Simplified Chinese', flag: '🇨🇳' },
  { code: 'zh-TW', name: '繁體中文', englishName: 'Traditional Chinese', flag: '🇹🇼' },
  { code: 'ja', name: '日本語', englishName: 'Japanese', flag: '🇯🇵' },
  { code: 'ko', name: '한국어', englishName: 'Korean', flag: '🇰🇷' },
  { code: 'de', name: 'Deutsch', englishName: 'German', flag: '🇩🇪' },
  { code: 'fr', name: 'Français', englishName: 'French', flag: '🇫🇷' },
  { code: 'es', name: 'Español', englishName: 'Spanish', flag: '🇪🇸' },
  { code: 'ru', name: 'Русский', englishName: 'Russian', flag: '🇷🇺' },
  { code: 'pt', name: 'Português', englishName: 'Portuguese', flag: '🇧🇷' },
];

/**
 * Default locale
 */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Get locale info by code
 */
export function getLocaleInfo(code: Locale): LocaleInfo | undefined {
  return SUPPORTED_LOCALES.find(locale => locale.code === code);
}

/**
 * Get display string for locale (with optional flag)
 */
export function getLocaleDisplayString(code: Locale, includeFlag = true): string {
  const info = getLocaleInfo(code);
  if (!info) return code;

  return includeFlag && info.flag
    ? `${info.flag} ${info.name} (${info.englishName})`
    : `${info.name} (${info.englishName})`;
}

/**
 * Get sorted list of locales for UI dropdown
 */
export function getLocalesForDropdown(): LocaleInfo[] {
  // Sort by English name for consistent ordering
  return [...SUPPORTED_LOCALES].sort((a, b) =>
    a.englishName.localeCompare(b.englishName)
  );
}

/**
 * Validate if a string is a valid locale code
 */
export function isValidLocaleCode(code: string): code is Locale {
  return SUPPORTED_LOCALES.some(locale => locale.code === code);
}

/**
 * Language family grouping (for future features)
 */
export const LANGUAGE_FAMILIES = {
  GERMANIC: ['en', 'de'],
  ROMANCE: ['fr', 'es', 'pt'],
  SLAVIC: ['ru'],
  ASIAN: ['zh-CN', 'zh-TW', 'ja', 'ko'],
} as const;

/**
 * Locale to region mapping (for future regional features)
 */
export const LOCALE_REGIONS = {
  'en': 'AMERICA',
  'zh-CN': 'ASIA',
  'zh-TW': 'ASIA',
  'ja': 'ASIA',
  'ko': 'ASIA',
  'de': 'EUROPE',
  'fr': 'EUROPE',
  'es': 'AMERICA',
  'ru': 'EUROPE',
  'pt': 'AMERICA',
} as const;

/**
 * Common translation keys that might be used across the plugin
 * These are utility keys for shared UI elements
 */
export const COMMON_KEYS = {
  // Buttons
  SAVE: 'common.save',
  CANCEL: 'common.cancel',
  DELETE: 'common.delete',
  EDIT: 'common.edit',
  ADD: 'common.add',
  REMOVE: 'common.remove',

  // Status
  LOADING: 'common.loading',
  ERROR: 'common.error',
  SUCCESS: 'common.success',
  WARNING: 'common.warning',

  // UI
  SETTINGS: 'common.settings',
  ADVANCED: 'common.advanced',
  ENABLED: 'common.enabled',
  DISABLED: 'common.disabled',

  // Actions
  CONFIRM: 'common.confirm',
  CLEAR: 'common.clear',
  RESET: 'common.reset',
} as const;

/**
 * Helper to check if locale uses RTL (right-to-left) text direction
 * Currently all supported locales are LTR, but this is here for future expansion
 */
export function isRTL(locale: Locale): boolean {
  const rtlLocales: Locale[] = []; // Add RTL locales here when supported
  return rtlLocales.includes(locale);
}

/**
 * Get font family suggestion for locale
 * Useful for ensuring proper rendering of characters
 */
export function getFontFamily(locale: Locale): string {
  const fontMap: Record<Locale, string> = {
    'en': 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont',
    'zh-CN': 'system-ui, -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif',
    'zh-TW': 'system-ui, -apple-system, "Microsoft JhengHei", "PingFang TC", sans-serif',
    'ja': 'system-ui, -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif',
    'ko': 'system-ui, -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif',
    'de': 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont',
    'fr': 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont',
    'es': 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont',
    'ru': 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont',
    'pt': 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont',
  };

  return fontMap[locale] || fontMap['en'];
}

/**
 * Locale grouping for batch operations
 */
export const LOCALE_GROUPS = {
  ALL: SUPPORTED_LOCALES.map(l => l.code),
  ASIAN: ['zh-CN', 'zh-TW', 'ja', 'ko'],
  EUROPEAN: ['de', 'fr', 'ru', 'pt'],
  ENGLISH_BASED: ['en'],
  SPANISH_PORTUGUESE: ['es', 'pt'],
} as const;

/**
 * Helper to get locale group
 */
export function getLocaleGroup(locale: Locale): readonly Locale[] {
  for (const [, locales] of Object.entries(LOCALE_GROUPS)) {
    if ((locales as readonly Locale[]).includes(locale)) {
      return locales as readonly Locale[];
    }
  }
  return [locale] as const;
}
