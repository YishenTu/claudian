import { type App, Modal } from 'obsidian';

import type {
  CollabFeaturePort,
  CollabLocalProjectSummary,
} from '@/core/collab';
import { t } from '@/i18n/i18n';

type JoinProjectPort = Pick<CollabFeaturePort, 'joinProject' | 'resumeSetup'>;

export interface JoinProjectModalOptions {
  readonly onClosed?: () => void;
  readonly onJoined?: (project: CollabLocalProjectSummary) => void;
}

export class JoinProjectModal extends Modal {
  private abortController = new AbortController();
  private invitationInput: HTMLTextAreaElement | null = null;
  private joinButton: HTMLButtonElement | null = null;
  private memberNameInput: HTMLInputElement | null = null;
  private operationGeneration = 0;
  private statusEl: HTMLDivElement | null = null;

  constructor(
    app: App,
    private readonly port: JoinProjectPort,
    private readonly options: JoinProjectModalOptions = {},
  ) {
    super(app);
  }

  onOpen(): void {
    this.abortController = new AbortController();
    this.operationGeneration += 1;
    this.setTitle(t('collab.joinProject.title'));
    this.modalEl.classList.add('claudian-collab-join-modal');
    this.contentEl.replaceChildren();

    const invitationField = this.contentEl.createDiv({ cls: 'claudian-collab-join-field' });
    invitationField.createEl('label', {
      attr: { for: 'claudian-collab-join-invitation' },
      text: t('collab.joinProject.invitation'),
    });
    this.invitationInput = invitationField.createEl('textarea', {
      attr: {
        'data-field': 'invitation',
        id: 'claudian-collab-join-invitation',
        placeholder: t('collab.joinProject.invitationPlaceholder'),
        rows: '5',
      },
    });

    const memberField = this.contentEl.createDiv({ cls: 'claudian-collab-join-field' });
    memberField.createEl('label', {
      attr: { for: 'claudian-collab-join-member-name' },
      text: t('collab.joinProject.memberName'),
    });
    this.memberNameInput = memberField.createEl('input', {
      attr: {
        'data-field': 'member-name',
        id: 'claudian-collab-join-member-name',
        placeholder: t('collab.joinProject.memberNamePlaceholder'),
        type: 'text',
      },
    });
    this.invitationInput.addEventListener('input', () => this.updateJoinButton());
    this.memberNameInput.addEventListener('input', () => this.updateJoinButton());

    this.statusEl = this.contentEl.createDiv({ cls: 'claudian-collab-join-status' });
    const actions = this.contentEl.createDiv({ cls: 'claudian-collab-join-actions' });
    const cancel = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('common.cancel'),
    });
    cancel.addEventListener('click', () => this.close());
    this.joinButton = actions.createEl('button', {
      attr: { 'data-action': 'join', type: 'button' },
      cls: 'mod-cta',
      text: t('collab.joinProject.join'),
    });
    this.joinButton.disabled = true;
    this.joinButton.addEventListener('click', () => {
      void this.runJoin();
    });
  }

  onClose(): void {
    this.abortController.abort();
    this.operationGeneration += 1;
    this.contentEl.replaceChildren();
    this.options.onClosed?.();
  }

  private async runJoin(): Promise<void> {
    if (!this.joinButton || this.joinButton.disabled) return;
    const generation = ++this.operationGeneration;
    this.joinButton.disabled = true;
    this.renderStatus(t('collab.joinProject.joining'));
    const result = await this.port.joinProject({
      encodedInvitation: this.invitationInput?.value.trim() ?? '',
      memberDisplayName: this.memberNameInput?.value.trim() ?? '',
    }, { signal: this.abortController.signal });
    if (!this.isCurrent(generation)) return;
    if (result.status === 'success') {
      this.options.onJoined?.(result.value);
      this.close();
      return;
    }
    if (result.status === 'recovery-required') {
      this.renderResume(result.operationId);
      return;
    }
    this.renderStatus(t('collab.joinProject.joinFailed'), true);
    this.updateJoinButton();
  }

  private renderResume(operationId: string): void {
    if (!this.statusEl) return;
    this.statusEl.replaceChildren();
    this.statusEl.createDiv({
      cls: 'claudian-collab-join-warning',
      text: t('collab.joinProject.resumeRequired'),
    });
    const resume = this.statusEl.createEl('button', {
      attr: { 'data-action': 'resume', type: 'button' },
      text: t('collab.joinProject.resume'),
    });
    resume.addEventListener('click', () => {
      void this.runResume(operationId, resume);
    });
  }

  private async runResume(
    operationId: string,
    button: HTMLButtonElement,
  ): Promise<void> {
    const generation = ++this.operationGeneration;
    button.disabled = true;
    this.renderStatus(t('collab.joinProject.joining'));
    const result = await this.port.resumeSetup(
      { operationId },
      { signal: this.abortController.signal },
    );
    if (!this.isCurrent(generation)) return;
    if (result.status === 'success') {
      this.options.onJoined?.(result.value);
      this.close();
      return;
    }
    this.renderStatus(t('collab.joinProject.resumeFailed'), true);
  }

  private renderStatus(text: string, warning = false): void {
    if (!this.statusEl) return;
    this.statusEl.replaceChildren();
    if (!text) return;
    this.statusEl.createDiv({
      cls: warning ? 'claudian-collab-join-warning' : undefined,
      text,
    });
  }

  private updateJoinButton(): void {
    if (!this.joinButton) return;
    this.joinButton.disabled = !this.invitationInput?.value.trim()
      || !this.memberNameInput?.value.trim();
  }

  private isCurrent(generation: number): boolean {
    return generation === this.operationGeneration && !this.abortController.signal.aborted;
  }
}
