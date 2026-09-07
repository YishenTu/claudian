import * as de from '@/i18n/locales/de.json';
import * as en from '@/i18n/locales/en.json';
import * as es from '@/i18n/locales/es.json';
import * as fr from '@/i18n/locales/fr.json';
import * as ja from '@/i18n/locales/ja.json';
import * as ko from '@/i18n/locales/ko.json';
import * as pt from '@/i18n/locales/pt.json';
import * as ru from '@/i18n/locales/ru.json';
import * as zhCN from '@/i18n/locales/zh-CN.json';
import * as zhTW from '@/i18n/locales/zh-TW.json';

interface TranslationTree {
  [key: string]: string | TranslationTree;
}

const locales = {
  de,
  es,
  fr,
  ja,
  ko,
  pt,
  ru,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
} as const;

function flattenTranslations(
  translations: TranslationTree,
  prefix = '',
  out: Record<string, string> = {}
): Record<string, string> {
  for (const [key, value] of Object.entries(translations)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      flattenTranslations(value as TranslationTree, nextKey, out);
      continue;
    }

    out[nextKey] = String(value);
  }

  return out;
}

describe('locale files', () => {
  const english = flattenTranslations(en as unknown as TranslationTree);

  it('keeps every locale structurally aligned with the English dictionary', () => {
    const englishKeys = Object.keys(english).sort();
    for (const translations of Object.values(locales)) {
      const localeKeys = Object.keys(flattenTranslations(translations as unknown as TranslationTree)).sort();
      expect(localeKeys).toEqual(englishKeys);
    }
  });
});
