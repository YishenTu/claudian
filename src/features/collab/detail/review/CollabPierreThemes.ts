import { createThemeCollection, type ThemeDescriptor, type ThemeLike } from '@pierre/theming';
import { normalizeTheme } from '@shikijs/core';

interface ThemeModule<TTheme extends ThemeLike> {
  readonly default: TTheme;
}

interface CreateThemeOptions<TTheme extends ThemeLike> {
  readonly collection?: string;
  readonly colorScheme?: 'dark' | 'light';
  readonly displayName?: string;
  readonly load: () => Promise<TTheme | ThemeModule<TTheme>>;
  readonly name: string;
}

const darkTheme = normalizeTheme({
  bg: '#0a0a0a',
  colors: {
    'editor.background': '#0a0a0a',
    'editor.foreground': '#fafafa',
    'gitDecoration.addedResourceForeground': '#07c480',
    'gitDecoration.deletedResourceForeground': '#ff2e3f',
    'gitDecoration.modifiedResourceForeground': '#009fff',
  },
  fg: '#fafafa',
  name: 'pierre-dark',
  settings: [],
  type: 'dark',
});

const lightTheme = normalizeTheme({
  bg: '#ffffff',
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#0a0a0a',
    'gitDecoration.addedResourceForeground': '#18a46c',
    'gitDecoration.deletedResourceForeground': '#d5512f',
    'gitDecoration.modifiedResourceForeground': '#1a85d4',
  },
  fg: '#0a0a0a',
  name: 'pierre-light',
  settings: [],
  type: 'light',
});

function unwrapDefault<TTheme extends ThemeLike>(
  theme: TTheme | ThemeModule<TTheme>,
): TTheme {
  return 'default' in theme ? theme.default : theme;
}

export function createTheme<TTheme extends ThemeLike = ThemeLike>(
  options: CreateThemeOptions<TTheme>,
): ThemeDescriptor<TTheme> {
  return {
    collection: options.collection,
    colorScheme: options.colorScheme,
    displayName: options.displayName,
    load: async () => normalizeTheme(
      unwrapDefault(await options.load()),
    ) as unknown as TTheme,
    name: options.name,
  };
}

export const pierreThemes = createThemeCollection({
  themes: [
    {
      collection: 'pierre',
      colorScheme: 'dark',
      displayName: 'Pierre Dark',
      load: async () => darkTheme,
      name: darkTheme.name,
    },
    {
      collection: 'pierre',
      colorScheme: 'light',
      displayName: 'Pierre Light',
      load: async () => lightTheme,
      name: lightTheme.name,
    },
  ],
});

export const shikiThemes = createThemeCollection({ themes: [] });
export const themes = pierreThemes;
