import { type App, Menu, Modal, Notice, type Plugin, Setting } from 'obsidian';

import type { ConversationNamingAPI, NamingMode } from '@/core/naming/ConversationNamingAPI';
import { resolveTitleGenerationLocale } from '@/core/prompt/titleGeneration';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { getLocaleInfo } from '@/i18n/constants';
import { t } from '@/i18n/i18n';

import { ConversationNamingService } from './ConversationNamingService';

class NamingConfirmation extends Modal {
  constructor(app: App, private readonly message: string, private readonly confirm: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t('naming.confirmTitle'));
    this.contentEl.createEl('p', { text: this.message });
    const controls = this.contentEl.createDiv();
    const cancel = controls.createEl('button', { text: t('naming.cancel'), attr: { type: 'button' } });
    cancel.addEventListener('click', () => this.close());
    const accept = controls.createEl('button', { text: t('naming.confirm'), attr: { type: 'button' } });
    accept.addEventListener('click', () => { this.close(); this.confirm(); });
  }
  onClose(): void { this.contentEl.empty(); }
}

class ShortTitleEditor extends Modal {
  constructor(app: App, private readonly current: string, private readonly save: (value: string) => Promise<void>) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t('naming.editShort'));
    let value = this.current;
    new Setting(this.contentEl).setName(t('naming.shortLabel')).addText(input => input
      .setValue(value).onChange(next => { value = next; }));
    const save = this.contentEl.createEl('button', { text: t('naming.save'), attr: { type: 'button' } });
    save.addEventListener('click', () => {
      const next = value.trim();
      if (!next || Array.from(next).length > 32) { new Notice(t('naming.invalidShort')); return; }
      void this.save(next).then(() => this.close()).catch(error => new Notice(String(error)));
    });
  }
  onClose(): void { this.contentEl.empty(); }
}

/** Optional built-in consumer of the same public API used by companion plugins. */
export class ConversationNamingFeature {
  private readonly service: ConversationNamingService;
  private readonly ribbon: HTMLElement;

  constructor(private readonly plugin: Plugin, private readonly host: Pick<ChatFeatureHost, 'settings'>, private readonly api: ConversationNamingAPI) {
    this.service = new ConversationNamingService(api, {
      language: () => getLocaleInfo(resolveTitleGenerationLocale(host.settings))?.englishName ?? 'English',
      automatic: () => host.settings.enableAutoTitleGeneration,
      onFailure: error => new Notice(`${t('naming.failed')} ${error instanceof Error ? error.message : String(error)}`),
    });
    this.ribbon = plugin.addRibbonIcon('wand-sparkles', t('naming.menu'), event => this.openMenu(event));
    for (const mode of ['both', 'long', 'short'] as const) {
      plugin.addCommand({ id: `intelligent-naming-${mode}`, name: t(`naming.${mode}`), callback: () => this.regenerate(mode) });
    }
    plugin.addCommand({ id: 'intelligent-naming-edit-short', name: t('naming.editShort'), callback: () => this.editShort() });
    for (const days of [2, 3, 7, 30, null]) {
      plugin.addCommand({ id: `intelligent-naming-batch-${days ?? 'all'}`, name: `${t('naming.batch')} ${days ?? t('naming.all')}`, callback: () => this.confirmBatch(days) });
    }
    this.syncEnabled();
  }

  syncEnabled(): void {
    if (this.host.settings.enableIntelligentConversationNaming === true && !this.service.enabled) {
      try { this.service.enable(); } catch (error) { new Notice(`${t('naming.ownerConflict')} ${String(error)}`); }
    } else if (!this.host.settings.enableIntelligentConversationNaming) this.service.disable();
    this.ribbon.style.display = this.service.enabled ? '' : 'none';
  }

  dispose(): void { this.service.disable(); }

  private openMenu(event: MouseEvent): void {
    const menu = new Menu();
    if (!this.service.enabled) {
      menu.addItem(item => item.setTitle(t('naming.enableHint')).setDisabled(true));
    }
    for (const mode of ['both', 'long', 'short'] as const) {
      menu.addItem(item => item.setTitle(t(`naming.${mode}`)).setDisabled(!this.service.enabled).onClick(() => this.regenerate(mode)));
    }
    menu.addItem(item => item.setTitle(t('naming.editShort')).setDisabled(!this.service.enabled).onClick(() => this.editShort()));
    menu.addSeparator();
    for (const days of [2, 3, 7, 30, null]) {
      menu.addItem(item => item.setTitle(`${t('naming.batch')} ${days === null ? t('naming.all') : `${days} ${t('naming.days')}`}`)
        .setDisabled(!this.service.enabled).onClick(() => this.confirmBatch(days)));
    }
    menu.showAtMouseEvent(event);
  }

  private regenerate(mode: NamingMode): void {
    if (!this.service.enabled) { new Notice(t('naming.enableHint')); return; }
    const id = this.api.getActiveConversationId();
    if (!id) { new Notice(t('naming.noConversation')); return; }
    new NamingConfirmation(this.plugin.app, t('naming.overwriteWarning'), () => {
      void (async () => {
        const before = this.api.getConversationSnapshot(id);
        if (!before) return;
        const first = await this.api.getFirstUserText(id);
        const outcome = await this.service.generate(id, first ?? before.longTitle, mode, before);
        new Notice(outcome === 'updated' ? t('naming.updated') : outcome === 'conflict' ? t('naming.conflict') : t('naming.notUpdated'));
      })().catch(error => new Notice(String(error)));
    }).open();
  }

  private editShort(): void {
    const id = this.api.getActiveConversationId();
    const before = id ? this.api.getConversationSnapshot(id) : null;
    if (!id || !before) { new Notice(t('naming.noConversation')); return; }
    new ShortTitleEditor(this.plugin.app, before.shortTitle ?? '', async value => {
      const result = await this.api.updateTitles(id, { expectedShortTitle: before.shortTitle, shortTitle: value });
      new Notice(result.shortTitle ? t('naming.updated') : t('naming.conflict'));
    }).open();
  }

  private confirmBatch(days: number | null): void {
    if (!this.service.enabled) { new Notice(t('naming.enableHint')); return; }
    const cutoff = days === null ? -Infinity : Date.now() - days * 86400000;
    const ids = this.api.listConversationSnapshots().filter(value => !value.shortTitle && value.createdAt >= cutoff).map(value => value.conversationId);
    new NamingConfirmation(this.plugin.app, `${t('naming.batchWarning')} ${ids.length}`, () => {
      void this.service.batch(days, ids).then(result => new Notice(`${t('naming.batchResult')} ${result.updated}/${result.failed}/${result.skipped}`))
        .catch(error => new Notice(String(error)));
    }).open();
  }
}
