import { t } from '@/i18n/i18n';

/**
 * Tailored guidance for users still on OpenCode v1 (support removed in #1687, 2026-10-29). Remove this
 * notice, its locale keys and style rule, and the v1 arm in `parseOpencodeNativeVersion` after 2027-01-29;
 * the generic unsupported-version error then covers v1.
 */
export function renderOpencodeMigrationNotice(container: HTMLElement): (version: string | null) => void {
  const notice = container.createDiv({
    cls: 'setting-item-description claudian-opencode-migration-notice',
    attr: { role: 'status' },
  });
  notice.hidden = true;
  notice.createSpan({ text: `${t('settings.opencode.migrationNotice.text')} ` });
  notice.createEl('a', {
    text: t('settings.opencode.migrationNotice.link'),
    attr: { href: 'https://opencode.ai/v2/docs/migrate-v1' },
  });
  return (version) => { notice.hidden = !version?.startsWith('1.'); };
}
