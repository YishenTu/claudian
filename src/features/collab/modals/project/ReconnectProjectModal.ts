import { type App, Modal } from 'obsidian';

import type {
  CollabFeaturePort,
  CollabLocalProjectSummary,
} from '@/core/collab';
import { t } from '@/i18n/i18n';

type ReconnectProjectPort = Pick<CollabFeaturePort, 'reconnectProject'>;

export interface ReconnectProjectModalOptions {
  readonly onClosed?: () => void;
  readonly onReconnected?: (project: CollabLocalProjectSummary) => void;
  readonly project: CollabLocalProjectSummary;
}

export class ReconnectProjectModal extends Modal {
  private abortController = new AbortController();
  private invitationInput: HTMLTextAreaElement | null = null;
  private operationGeneration = 0;
  private reconnectButton: HTMLButtonElement | null = null;
  private statusEl: HTMLDivElement | null = null;

  constructor(
    app: App,
    private readonly port: ReconnectProjectPort,
    private readonly options: ReconnectProjectModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.abortController = new AbortController();
    this.operationGeneration += 1;
    this.setTitle(t('collab.reconnectProject.title'));
    this.modalEl.classList.add('claudian-collab-join-modal');
    this.contentEl.replaceChildren();

    this.contentEl.createDiv({
      cls: 'claudian-collab-join-description',
      text: t('collab.reconnectProject.description', {
        name: this.options.project.name,
      }),
    });
    const field = this.contentEl.createDiv({ cls: 'claudian-collab-join-field' });
    field.createEl('label', {
      attr: { for: 'claudian-collab-reconnect-invitation' },
      text: t('collab.reconnectProject.invitation'),
    });
    this.invitationInput = field.createEl('textarea', {
      attr: {
        'data-field': 'invitation',
        id: 'claudian-collab-reconnect-invitation',
        placeholder: t('collab.reconnectProject.invitationPlaceholder'),
        rows: '5',
      },
    });
    this.invitationInput.addEventListener('input', () => this.updateButton());

    this.statusEl = this.contentEl.createDiv({ cls: 'claudian-collab-join-status' });
    const actions = this.contentEl.createDiv({ cls: 'claudian-collab-join-actions' });
    const cancel = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('common.cancel'),
    });
    cancel.addEventListener('click', () => this.close());
    this.reconnectButton = actions.createEl('button', {
      attr: { 'data-action': 'reconnect', type: 'button' },
      cls: 'mod-cta',
      text: t('collab.reconnectProject.reconnect'),
    });
    this.reconnectButton.disabled = true;
    this.reconnectButton.addEventListener('click', () => {
      void this.runReconnect();
    });
  }

  onClose(): void {
    this.abortController.abort();
    this.operationGeneration += 1;
    this.contentEl.replaceChildren();
    this.options.onClosed?.();
  }

  private async runReconnect(): Promise<void> {
    if (!this.reconnectButton || this.reconnectButton.disabled) return;
    const generation = ++this.operationGeneration;
    this.reconnectButton.disabled = true;
    this.renderStatus(t('collab.reconnectProject.reconnecting'));
    const result = await this.port.reconnectProject({
      encodedInvitation: this.invitationInput?.value.trim() ?? '',
      projectId: this.options.project.id,
    }, { signal: this.abortController.signal });
    if (!this.isCurrent(generation)) return;
    if (result.status === 'success') {
      this.options.onReconnected?.(result.value);
      this.close();
      return;
    }
    this.renderStatus(t('collab.reconnectProject.failed'), true);
    this.updateButton();
  }

  private renderStatus(text: string, warning = false): void {
    if (!this.statusEl) return;
    this.statusEl.replaceChildren();
    this.statusEl.createDiv({
      attr: warning ? { role: 'alert' } : { role: 'status' },
      cls: warning ? 'claudian-collab-join-warning' : undefined,
      text,
    });
  }

  private updateButton(): void {
    if (!this.reconnectButton) return;
    this.reconnectButton.disabled = !this.invitationInput?.value.trim();
  }

  private isCurrent(generation: number): boolean {
    return generation === this.operationGeneration && !this.abortController.signal.aborted;
  }
}
