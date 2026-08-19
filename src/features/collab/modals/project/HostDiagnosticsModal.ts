import { type App, Modal } from 'obsidian';

import type { LanHostDiagnostics } from '@/features/collab/modals/project/LanHostSection';
import { t } from '@/i18n/i18n';

export interface HostDiagnosticsModalOptions {
  readonly copyText?: (text: string) => Promise<void>;
  readonly diagnostics: LanHostDiagnostics;
  readonly onClosed?: () => void;
  readonly projectName: string;
}

export class HostDiagnosticsModal extends Modal {
  private opened = false;

  constructor(
    app: App,
    private readonly options: HostDiagnosticsModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.opened = true;
    this.setTitle(t('collab.host.diagnostics'));
    this.modalEl.classList.add('claudian-collab-host-diagnostics-modal');
    const serialized = this.serialize();
    this.contentEl.replaceChildren();
    this.contentEl.createEl('pre', { text: serialized });
    const actions = this.contentEl.createDiv({ cls: 'claudian-collab-host-actions' });
    const copy = actions.createEl('button', {
      attr: { 'data-action': 'copy-host-diagnostics', type: 'button' },
      text: t('collab.host.copyDiagnostics'),
    });
    copy.disabled = !this.options.copyText;
    const status = actions.createSpan({ attr: { 'aria-live': 'polite' } });
    copy.addEventListener('click', () => {
      if (!this.options.copyText) return;
      copy.disabled = true;
      void this.options.copyText(serialized).then(() => {
        if (!this.opened || !copy.isConnected) return;
        status.setText(t('collab.host.diagnosticsCopied'));
      }, () => {
        if (!this.opened || !copy.isConnected) return;
        copy.disabled = false;
        status.setText(t('collab.host.diagnosticsCopyFailed'));
      });
    });
  }

  onClose(): void {
    this.opened = false;
    this.contentEl.replaceChildren();
    this.options.onClosed?.();
  }

  private serialize(): string {
    return JSON.stringify({
      ...this.options.diagnostics,
      projectName: this.options.projectName,
    }, null, 2);
  }
}
