import { t } from '@/i18n/i18n';

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
