export function renderOpencodeMigrationNotice(container: HTMLElement): (version: string | null) => void {
  const notice = container.createDiv({
    cls: 'setting-item-description claudian-opencode-migration-notice',
    attr: { role: 'status' },
  });
  notice.hidden = true;
  notice.createSpan({ text: 'Claudian now supports OpenCode v2. OpenCode v1 support ends on October 30, 2026. ' });
  notice.createEl('a', {
    text: 'Migrate to OpenCode v2',
    attr: { href: 'https://opencode.ai/v2/docs/migrate-v1' },
  });
  return (version) => { notice.hidden = !version?.startsWith('1.'); };
}
