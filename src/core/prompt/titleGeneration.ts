import { DEFAULT_LOCALE, getLocaleInfo } from '../../i18n/constants';
import type { Locale } from '../../i18n/types';

const MAX_TITLE_INPUT_LENGTH = 500;
const MAX_TITLE_LENGTH = 50;

const TITLE_GENERATION_SYSTEM_PROMPT_BASE = `You are a specialist in summarizing user intent.

**Task**: Generate a **concise, descriptive title** (max 50 chars) summarizing the user's task/request.

**Rules**:
1.  **Format**: Use sentence case when the target language has letter case. No surrounding quotes or trailing punctuation.
2.  **Structure**: Prefer concise, action-led wording when natural for the selected language.
3.  **Forbidden**: "Conversation with...", "Help me...", "Question about...", "I need...".
4.  **Tech Context**: Include the primary programming language or framework only when it is relevant and confidently identifiable.`;

interface TitleGenerationLocaleSettings {
  locale?: string;
  titleGenerationLocale?: string;
}

export function resolveTitleGenerationLocale(
  settings: TitleGenerationLocaleSettings,
): Locale {
  const titleLocale = getLocaleInfo(settings.titleGenerationLocale ?? '');
  if (titleLocale) {
    return titleLocale.code;
  }

  return getLocaleInfo(settings.locale ?? '')?.code ?? DEFAULT_LOCALE;
}

export function buildTitleGenerationSystemPrompt(locale: string = DEFAULT_LOCALE): string {
  const localeInfo = getLocaleInfo(locale) ?? getLocaleInfo(DEFAULT_LOCALE);
  const language = localeInfo?.englishName ?? 'English';

  return `${TITLE_GENERATION_SYSTEM_PROMPT_BASE}
5.  **Language**: Write the title in ${language}. Apply the format and structure rules naturally for that language.

**Output**: Return ONLY the raw title text.`;
}

export const TITLE_GENERATION_SYSTEM_PROMPT = buildTitleGenerationSystemPrompt();

export function buildTitleGenerationPrompt(userMessage: string): string {
  const truncated = userMessage.length > MAX_TITLE_INPUT_LENGTH
    ? `${userMessage.slice(0, MAX_TITLE_INPUT_LENGTH)}...`
    : userMessage;
  return `User's request:\n"""\n${truncated}\n"""\n\nGenerate a title for this conversation:`;
}

export function parseTitleGenerationResponse(responseText: string): string | null {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return null;
  }

  let title = trimmed;
  if (
    (title.startsWith('"') && title.endsWith('"'))
    || (title.startsWith("'") && title.endsWith("'"))
  ) {
    title = title.slice(1, -1);
  }

  title = title.replace(/[.!?:;,]+$/, '');

  if (title.length > MAX_TITLE_LENGTH) {
    title = `${title.slice(0, MAX_TITLE_LENGTH - 3)}...`;
  }

  return title || null;
}
