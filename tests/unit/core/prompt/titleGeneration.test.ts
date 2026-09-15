import {
buildTitleGenerationSystemPrompt,
resolveTitleGenerationLocale
} from '@/core/prompt/titleGeneration';

describe('titleGeneration', () => {

  it('uses the i18n default language when no locale is provided', () => {
    expect(buildTitleGenerationSystemPrompt()).toContain('Write the title in English');
  });

  it('adds a language instruction for the selected locale', () => {
    expect(buildTitleGenerationSystemPrompt('ja')).toContain('Write the title in Japanese');
  });

  it('falls back to the i18n default language for an invalid stored locale', () => {
    expect(buildTitleGenerationSystemPrompt('invalid-locale')).toContain(
      'Write the title in English',
    );
  });

  it('uses the interface locale when no title locale is selected', () => {
    expect(resolveTitleGenerationLocale({
      locale: 'ja',
      titleGenerationLocale: '',
    })).toBe('ja');
  });

  it('prefers the independent title locale over the interface locale', () => {
    expect(resolveTitleGenerationLocale({
      locale: 'en',
      titleGenerationLocale: 'ja',
    })).toBe('ja');
  });

  it('uses the i18n default when both stored locales are invalid', () => {
    expect(resolveTitleGenerationLocale({
      locale: 'invalid-interface-locale',
      titleGenerationLocale: 'invalid-title-locale',
    })).toBe('en');
  });
});
