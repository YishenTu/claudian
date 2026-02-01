import { type App, Modal } from 'obsidian';

import { t } from '../../i18n';

export type ForkTarget = 'new-tab' | 'current-tab';

export function chooseForkTarget(app: App): Promise<ForkTarget | null> {
  return new Promise(resolve => {
    new ForkTargetModal(app, resolve).open();
  });
}

class ForkTargetModal extends Modal {
  private resolve: (target: ForkTarget | null) => void;
  private resolved = false;

  constructor(app: App, resolve: (target: ForkTarget | null) => void) {
    super(app);
    this.resolve = resolve;
  }

  onOpen() {
    this.setTitle(t('chat.fork.chooseTarget'));
    this.modalEl.addClass('claudian-fork-target-modal');

    const list = this.contentEl.createDiv({ cls: 'claudian-fork-target-list' });

    this.createOption(list, 'current-tab', t('chat.fork.targetCurrentTab'));
    this.createOption(list, 'new-tab', t('chat.fork.targetNewTab'));
  }

  private createOption(container: HTMLElement, target: ForkTarget, label: string): void {
    const item = container.createDiv({ cls: 'claudian-fork-target-option', text: label });
    item.addEventListener('click', () => {
      this.resolved = true;
      this.resolve(target);
      this.close();
    });
  }

  onClose() {
    if (!this.resolved) {
      this.resolve(null);
    }
    this.contentEl.empty();
  }
}
