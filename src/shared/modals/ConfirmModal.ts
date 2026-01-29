import { type App,Modal, Setting } from 'obsidian';

import { t } from '../../i18n';

export function confirmDelete(app: App, message: string): Promise<boolean> {
  return new Promise(resolve => {
    new ConfirmModal(app, message, resolve).open();
  });
}

class ConfirmModal extends Modal {
  private message: string;
  private resolve: (confirmed: boolean) => void;
  private resolved = false;

  constructor(app: App, message: string, resolve: (confirmed: boolean) => void) {
    super(app);
    this.message = message;
    this.resolve = resolve;
  }

  onOpen() {
    this.setTitle(t('common.confirm'));
    this.modalEl.addClass('claudian-confirm-modal');

    this.contentEl.createEl('p', { text: this.message });

    new Setting(this.contentEl)
      .addButton(btn =>
        btn
          .setButtonText(t('common.cancel'))
          .onClick(() => this.close())
      )
      .addButton(btn =>
        btn
          .setButtonText(t('common.delete'))
          .setWarning()
          .onClick(() => {
            this.resolved = true;
            this.resolve(true);
            this.close();
          })
      );
  }

  onClose() {
    if (!this.resolved) {
      this.resolve(false);
    }
    this.contentEl.empty();
  }
}
