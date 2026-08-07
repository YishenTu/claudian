import { Modal, Notice } from 'obsidian';

import type {
  ProviderDiagnosticErrorCategory,
  ProviderDiagnosticReport,
} from '../../../core/providers/ProviderDiagnostics';
import type {
  ProviderReadinessCheckId,
  ProviderReadinessRemediation,
  ProviderReadinessStatus,
} from '../../../core/providers/ProviderReadiness';
import { getLocale, t } from '../../../i18n/i18n';

export class ProviderDiagnosticModal extends Modal {
  constructor(
    app: Modal['app'],
    private readonly report: ProviderDiagnosticReport,
    private readonly onRetry?: () => void,
    private readonly onRebuildSession?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('claudian-provider-diagnostic-modal');
    const header = contentEl.createDiv({ cls: 'claudian-provider-diagnostic-header' });
    header.createDiv({
      cls: 'claudian-provider-diagnostic-kicker',
      text: t('settings.providerDiagnostics.kicker'),
    });
    header.createEl('h2', { text: t('settings.providerDiagnostics.title') });
    header.createDiv({
      cls: `claudian-provider-diagnostic-status is-${this.report.error.category}`,
      text: categoryLabel(this.report.error.category),
    });

    const details = contentEl.createEl('dl', { cls: 'claudian-provider-diagnostic-details' });
    this.addDetail(details, t('settings.providerDiagnostics.provider'), this.report.providerId);
    this.addDetail(details, t('settings.providerDiagnostics.category'), categoryLabel(this.report.error.category));
    this.addDetail(details, t('settings.providerDiagnostics.status'), statusLabel(this.report.runtimeStatus));
    this.addDetail(details, t('settings.providerDiagnostics.platform'), this.report.platform);
    this.addDetail(details, t('settings.providerDiagnostics.time'), formatDiagnosticTime(this.report.createdAt));

    if (this.report.readiness) {
      contentEl.createEl('h3', { text: t('settings.providerDiagnostics.readiness') });
      const readiness = contentEl.createEl('ul', { cls: 'claudian-provider-diagnostic-readiness' });
      for (const check of this.report.readiness.checks) {
        const remediation = check.remediation ? ` (${remediationLabel(check.remediation)})` : '';
        const item = readiness.createEl('li', { cls: `is-${check.status}` });
        item.createSpan({ cls: 'claudian-provider-diagnostic-check-dot' });
        item.createSpan({ text: `${checkLabel(check.id)}: ${checkStatusLabel(check.status)}${remediation}` });
      }
    }

    contentEl.createEl('h3', { text: t('settings.providerDiagnostics.whatHappened') });
    contentEl.createEl('pre', {
      cls: 'claudian-provider-diagnostic-message',
      text: this.report.error.message,
    });

    const actions = contentEl.createDiv({ cls: 'modal-button-container' });
    if (this.report.error.category === 'session-resume-failed' && this.onRebuildSession) {
      const rebuildButton = actions.createEl('button', { text: t('settings.providerDiagnostics.rebuild') });
      rebuildButton.addEventListener('click', () => {
        this.close();
        this.onRebuildSession?.();
      });
    }
    if (this.report.error.recoverable && this.onRetry) {
      const retryButton = actions.createEl('button', { text: t('settings.providerDiagnostics.retry') });
      retryButton.addEventListener('click', () => {
        this.close();
        this.onRetry?.();
      });
    }
    const copyButton = actions.createEl('button', { text: t('settings.providerDiagnostics.copy') });
    copyButton.addEventListener('click', () => {
      void this.copyReport();
    });
    const closeButton = actions.createEl('button', { text: t('settings.providerDiagnostics.close') });
    closeButton.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private addDetail(container: HTMLElement, label: string, value: string): void {
    container.createEl('dt', { text: label });
    container.createEl('dd', { text: value });
  }

  private async copyReport(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(this.report, null, 2));
      new Notice(t('settings.providerDiagnostics.copied'));
    } catch {
      new Notice(t('settings.providerDiagnostics.copyFailed'));
    }
  }
}

function categoryLabel(category: ProviderDiagnosticErrorCategory): string {
  const keys: Record<ProviderDiagnosticErrorCategory, Parameters<typeof t>[0]> = {
    'not-configured': 'settings.providerDiagnostics.categoryValue.not-configured',
    'cli-not-found': 'settings.providerDiagnostics.categoryValue.cli-not-found',
    'cli-start-failed': 'settings.providerDiagnostics.categoryValue.cli-start-failed',
    'session-resume-failed': 'settings.providerDiagnostics.categoryValue.session-resume-failed',
    'model-unavailable': 'settings.providerDiagnostics.categoryValue.model-unavailable',
    'permission-denied': 'settings.providerDiagnostics.categoryValue.permission-denied',
    timeout: 'settings.providerDiagnostics.categoryValue.timeout',
    'rate-limited': 'settings.providerDiagnostics.categoryValue.rate-limited',
    'protocol-error': 'settings.providerDiagnostics.categoryValue.protocol-error',
    authentication: 'settings.providerDiagnostics.categoryValue.authentication',
    provider: 'settings.providerDiagnostics.categoryValue.provider',
    unknown: 'settings.providerDiagnostics.categoryValue.unknown',
  };
  return t(keys[category]);
}

function statusLabel(status: ProviderDiagnosticReport['runtimeStatus']): string {
  return t(`settings.providerDiagnostics.statusValue.${status}`);
}

function checkLabel(id: ProviderReadinessCheckId): string {
  return t(`settings.providerDiagnostics.check.${id}`);
}

function checkStatusLabel(status: ProviderReadinessStatus): string {
  return t(`settings.providerDiagnostics.checkStatus.${status}`);
}

function remediationLabel(remediation: ProviderReadinessRemediation): string {
  return t(`settings.providerDiagnostics.remediation.${remediation}`);
}

function formatDiagnosticTime(timestamp: number): string {
  return new Intl.DateTimeFormat(getLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}
