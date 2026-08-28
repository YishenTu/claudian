import type {
  CollabFeaturePort,
  CollabHostStatus,
  CollabLocalProjectSummary,
} from '@/core/collab';
import { t } from '@/i18n/i18n';

export type LanHostSectionPort = Pick<
  CollabFeaturePort,
  'claimLegacyHostInstallation' | 'startHost' | 'stopHost'
>;

export interface LanHostDiagnostics {
  readonly error?: Readonly<Record<string, unknown>>;
  readonly projectId: string;
  readonly status: Exclude<CollabHostStatus, 'not-host'>;
}

export interface LanHostSectionOptions {
  readonly confirmLegacyClaim?: () => Promise<boolean>;
  readonly onOpenDiagnostics?: (diagnostics: LanHostDiagnostics) => void;
  readonly onStatusChanged?: (status: Exclude<CollabHostStatus, 'not-host'>) => void;
  readonly port: LanHostSectionPort;
  readonly project: CollabLocalProjectSummary;
}

type HostAction = 'start' | 'stop';

export class LanHostSection {
  private abortController = new AbortController();
  private destroyed = false;
  private errorAction: HostAction | null = null;
  private errorText: string | null = null;
  private lastError: Readonly<Record<string, unknown>> | null = null;
  private operationGeneration = 0;
  private project: CollabLocalProjectSummary;
  private readonly rootEl: HTMLDivElement;

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly options: LanHostSectionOptions,
  ) {
    this.project = options.project;
    this.rootEl = createDiv({ cls: 'claudian-collab-host-section' });
    this.render();
  }

  setProject(project: CollabLocalProjectSummary): void {
    if (this.destroyed) return;
    this.operationGeneration += 1;
    this.abortController.abort();
    this.abortController = new AbortController();
    this.project = project;
    this.errorAction = null;
    this.errorText = null;
    this.lastError = null;
    this.render();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.operationGeneration += 1;
    this.abortController.abort();
    this.rootEl.remove();
  }

  private render(): void {
    if (this.destroyed) return;
    const installationStatus = this.project.hostInstallationStatus;
    const hostStatus = this.project.hostStatus;
    if (installationStatus === 'not-host') {
      this.rootEl.remove();
      return;
    }
    if (!this.rootEl.isConnected) this.containerEl.appendChild(this.rootEl);
    this.rootEl.replaceChildren();
    const warning = hostStatus === 'needs-attention' || !!this.errorText;

    const header = this.rootEl.createDiv({ cls: 'claudian-collab-host-section-header' });
    header.createSpan({ text: t('collab.host.summary') });
    if (installationStatus === 'hosted-elsewhere') {
      header.createSpan({
        cls: 'claudian-collab-host-badge',
        text: t('collab.host.hostedElsewhere'),
      });
      return;
    }
    if (hostStatus === 'not-host') {
      this.rootEl.remove();
      return;
    }
    header.createSpan({
      cls: 'claudian-collab-host-badge',
      text: t('collab.host.hostedHere'),
    });
    this.renderStatusButton(header, hostStatus, warning);
    if (!warning) return;

    const body = this.rootEl.createDiv({ cls: 'claudian-collab-host-body' });
    if (this.errorText) {
      body.createDiv({
        attr: { role: 'alert' },
        cls: 'claudian-collab-host-error',
        text: this.errorText,
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
          ...(this.lastError ? { error: this.lastError } : {}),
          projectId: this.project.id,
          status: this.project.hostStatus === 'not-host'
            ? 'needs-attention'
            : this.project.hostStatus,
        });
      });
    }
  }

  private renderStatusButton(
    header: HTMLDivElement,
    status: Exclude<CollabHostStatus, 'not-host'>,
    warning: boolean,
  ): void {
    const pending = status === 'starting' || status === 'stopping';
    const action = this.errorAction
      ?? (status === 'running' || status === 'stopping' ? 'stop' : 'start');
    const retry = !!this.errorAction;
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
      cls: warning
        ? 'claudian-collab-host-badge claudian-collab-host-badge--warning'
        : 'claudian-collab-host-badge',
      text: this.statusLabel(status),
    });
    button.disabled = pending;
    if (pending) return;
    button.addEventListener('click', () => {
      void this.runAction(action);
    });
  }

  private async runAction(action: HostAction): Promise<void> {
    const generation = ++this.operationGeneration;
    this.abortController.abort();
    this.abortController = new AbortController();
    this.errorAction = null;
    this.errorText = null;
    this.lastError = null;
    if (
      action === 'start'
      && this.project.hostInstallationStatus === 'legacy-unbound'
    ) {
      const confirmed = await (this.options.confirmLegacyClaim?.() ?? Promise.resolve(false));
      if (
        !confirmed
        || this.destroyed
        || this.abortController.signal.aborted
        || generation !== this.operationGeneration
      ) {
        return;
      }
      const claim = await this.options.port.claimLegacyHostInstallation(
        this.project.id,
        { signal: this.abortController.signal },
      );
      if (
        this.destroyed
        || this.abortController.signal.aborted
        || generation !== this.operationGeneration
      ) {
        return;
      }
      if (claim.status !== 'success') {
        this.project = { ...this.project, hostStatus: 'needs-attention' };
        this.errorAction = action;
        this.lastError = 'error' in claim ? claim.error.toJSON() : null;
        this.errorText = t('collab.host.startFailed');
        this.render();
        return;
      }
      this.project = claim.value;
    }
    this.project = {
      ...this.project,
      hostStatus: action === 'start' ? 'starting' : 'stopping',
    };
    this.render();
    const result = action === 'start'
      ? await this.options.port.startHost(
        this.project.id,
        { signal: this.abortController.signal },
      )
      : await this.options.port.stopHost(
        this.project.id,
        { signal: this.abortController.signal },
      );
    if (
      this.destroyed
      || this.abortController.signal.aborted
      || generation !== this.operationGeneration
    ) {
      return;
    }
    if (result.status === 'success') {
      this.project = { ...this.project, hostStatus: result.value.status };
      this.errorAction = null;
      this.errorText = null;
      this.options.onStatusChanged?.(result.value.status);
    } else {
      this.project = { ...this.project, hostStatus: 'needs-attention' };
      this.errorAction = action;
      this.lastError = 'error' in result ? result.error.toJSON() : null;
      this.errorText = action === 'start'
        ? t('collab.host.startFailed')
        : t('collab.host.stopFailed');
    }
    this.render();
  }

  private statusLabel(status: Exclude<CollabHostStatus, 'not-host'>): string {
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
