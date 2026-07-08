import type * as en from './locales/en.json';

export type Locale = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'de' | 'fr' | 'es' | 'ru' | 'pt';

type DotJoin<Head extends string, Tail extends string> = `${Head}.${Tail}`;

type LeafKeys<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : T[K] extends Record<string, unknown>
      ? DotJoin<K, LeafKeys<T[K]>>
      : never;
}[keyof T & string];

export type TranslationKey = LeafKeys<typeof en>;
