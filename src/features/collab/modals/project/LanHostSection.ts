import type { CollabHostStatus } from '@/core/collab';
import type { ProjectHostAction, ProjectHostView } from '@/features/collab/modals/project/ProjectManagementSession';
import { t } from '@/i18n/i18n';

export interface LanHostDiagnostics {
  readonly error?: Readonly<Record<string, unknown>>;
  readonly projectId: string;
  readonly status: Exclude<CollabHostStatus, 'not-host'>;
}

export interface LanHostTransferAction {
  readonly disabled: boolean;
  readonly onClick: () => void;
}

export interface LanHostSectionOptions {
  readonly transferHost?: LanHostTransferAction;
  readonly state: ProjectHostView;
  readonly onAction: (action: ProjectHostAction) => void;
  readonly onOpenDiagnostics?: (diagnostics: LanHostDiagnostics) => void;
}

export class LanHostSection {
  private destroyed = false;
  private transferHost: LanHostTransferAction | undefined;
  private state: ProjectHostView;
  private readonly rootEl: HTMLDivElement;

  constructor(private readonly containerEl: HTMLElement, private readonly options: LanHostSectionOptions) {
    this.state = options.state;
    this.transferHost = options.transferHost;
    this.rootEl = createDiv({ cls: 'claudian-collab-host-section' });
    this.render();
  }

  setState(state: ProjectHostView, transferHost?: LanHostTransferAction): void {
    this.state = state;
    this.transferHost = transferHost;
    this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.rootEl.remove();
  }

  private render(): void {
    if (this.destroyed) return;
    const installationStatus = this.state.project.hostInstallationStatus;
    const hostStatus = this.state.status;
    const errorText = this.state.error
      ? t(this.state.error.action === 'start' ? 'collab.host.startFailed' : 'collab.host.stopFailed') : null;
    if (installationStatus === 'not-host') {
      this.rootEl.remove();
      return;
    }
    if (!this.rootEl.isConnected) this.containerEl.appendChild(this.rootEl);
    this.rootEl.replaceChildren();
    const warning = hostStatus === 'needs-attention' || !!errorText;

    const header = this.rootEl.createDiv({ cls: 'claudian-collab-host-section-header' });
    if (installationStatus === 'hosted-elsewhere') {
      header.createSpan({ text: t('collab.host.hostedElsewhereSummary') });
      return;
    }
    if (hostStatus === 'not-host') {
      this.rootEl.remove();
      return;
    }
    header.createSpan({ text: t('collab.host.hostedHereSummary') });
    const controls = header.createDiv({ cls: 'claudian-collab-host-actions' });
    this.#renderStatusButton(controls, hostStatus);
    if (this.transferHost) {
      const transfer = controls.createEl('button', {
        attr: { 'data-action': 'select-host-destination', type: 'button' },
        text: t('collab.access.transferHost'),
      });
      transfer.disabled = this.transferHost.disabled;
      transfer.addEventListener('click', () => this.transferHost?.onClick());
    }
    if (!warning) return;

    const body = this.rootEl.createDiv({ cls: 'claudian-collab-host-body' });
    if (errorText) {
      body.createDiv({
        attr: { role: 'alert' },
        cls: 'claudian-collab-host-error',
        text: errorText,
      });
    }
    const actions = body.createDiv({ cls: 'claudian-collab-host-actions' });
    if (this.options.onOpenDiagnostics) {
      const diagnostics = actions.createEl('button', {
        attr: { 'data-action': 'host-diagnostics', type: 'button' },
        text: t('collab.host.diagnostics'),
      });
      diagnostics.addEventListener('click', () => {
        this.options.onOpenDiagnostics?.({
          ...(this.state.error?.details ? { error: this.state.error?.details } : {}),
          projectId: this.state.project.id,
          status: errorText || this.state.project.hostStatus === 'not-host'
            ? 'needs-attention'
            : this.state.project.hostStatus,
        });
      });
    }
  }

  #renderStatusButton(
    header: HTMLDivElement,
    status: Exclude<CollabHostStatus, 'not-host'>,
  ): void {
    const pending = this.state.pending || status === 'starting' || status === 'stopping';
    const action = this.state.error?.action
      ?? (status === 'running' || status === 'stopping' ? 'stop' : 'start');
    const retry = !!this.state.error?.action;
    const button = header.createEl('button', {
      attr: {
        'data-action': retry
          ? 'retry-host'
          : action === 'start'
            ? 'start-host'
            : 'stop-host',
        'aria-label': retry
          ? t('collab.host.retry')
          : action === 'start'
            ? t('collab.host.start')
            : t('collab.host.stop'),
        title: retry
          ? t('collab.host.retry')
          : action === 'start'
            ? t('collab.host.start')
            : t('collab.host.stop'),
        type: 'button',
      },
      cls: 'mod-cta claudian-collab-host-status-button',
      text: this.#statusLabel(status),
    });
    button.disabled = pending;
    if (pending) return;
    button.addEventListener('click', () => {
      this.options.onAction(action);
    });
  }

  #statusLabel(status: Exclude<CollabHostStatus, 'not-host'>): string {
    switch (status) {
      case 'stopped':
        return t('collab.host.status.stopped');
      case 'starting':
        return t('collab.host.status.starting');
      case 'running':
        return t('collab.host.status.running');
      case 'stopping':
        return t('collab.host.status.stopping');
      case 'needs-attention':
        return t('collab.host.status.needsAttention');
    }
  }
}
