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

const localizedKeys = [
  'chat.fork.errorMessageNotFound',
  'chat.fork.errorNoSession',
  'chat.fork.errorNoActiveTab',
  'chat.bangBash.placeholder',
  'chat.bangBash.commandPanel',
  'chat.bangBash.copyAriaLabel',
  'chat.bangBash.clearAriaLabel',
  'chat.bangBash.statusLabel',
  'chat.bangBash.collapseOutput',
  'chat.bangBash.expandOutput',
  'chat.bangBash.running',
  'chat.bangBash.copyFailed',
  'settings.subagents.name',
  'settings.subagents.desc',
  'settings.subagents.noAgents',
  'settings.subagents.deleteConfirm',
  'settings.subagents.saveFailed',
  'settings.subagents.deleteFailed',
  'settings.subagents.renameCleanupFailed',
  'settings.subagents.created',
  'settings.subagents.updated',
  'settings.subagents.deleted',
  'settings.subagents.duplicateName',
  'settings.subagents.descriptionRequired',
  'settings.subagents.promptRequired',
  'settings.subagents.modal.titleEdit',
  'settings.subagents.modal.titleAdd',
  'settings.subagents.modal.nameDesc',
  'settings.subagents.modal.descriptionDesc',
  'settings.subagents.modal.descriptionPlaceholder',
  'settings.subagents.modal.advancedOptions',
  'settings.subagents.modal.modelDesc',
  'settings.subagents.modal.toolsDesc',
  'settings.subagents.modal.disallowedTools',
  'settings.subagents.modal.disallowedToolsDesc',
  'settings.subagents.modal.skills',
  'settings.subagents.modal.skillsDesc',
  'settings.subagents.modal.prompt',
  'settings.subagents.modal.promptDesc',
  'settings.subagents.modal.promptPlaceholder',
  'settings.enableBangBash.name',
  'settings.enableBangBash.desc',
  'settings.enableBangBash.validation.noNode',
] as const;

const staleBangBashDesc =
  'Type ! on empty input to enter bash mode. Runs commands directly via Node.js child_process.';

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

  it('keeps every locale structurally aligned with English', () => {
    const englishKeys = Object.keys(english).sort();

    for (const [locale, translations] of Object.entries(locales)) {
      const localeKeys = Object.keys(flattenTranslations(translations as unknown as TranslationTree)).sort();
      expect(localeKeys).toEqual(englishKeys);
      expect(locale).toBeTruthy();
    }
  });

  it('localizes the recent bang bash and subagent additions', () => {
    for (const translations of Object.values(locales)) {
      const locale = flattenTranslations(translations as unknown as TranslationTree);

      for (const key of localizedKeys) {
        expect(locale[key]).toBeDefined();
        expect(locale[key]).not.toBe(english[key]);
      }

      expect(locale['settings.enableBangBash.desc']).not.toBe(staleBangBashDesc);
    }
  });

  it('uses commands-and-skills copy for hidden Claude entries', () => {
    expect(english['settings.hiddenSlashCommands.name']).toBe('Hidden Commands and Skills');
    expect(english['settings.hiddenSlashCommands.desc']).toBe(
      'Hide specific commands and skills from the dropdown. Useful for hiding Claude Code entries that are not relevant to Claudian. Enter names without the leading slash, one per line.',
    );
  });
});
