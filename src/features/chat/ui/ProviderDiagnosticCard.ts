import type { App } from 'obsidian';

import type { ProviderDiagnosticReport } from '../../../core/providers/ProviderDiagnostics';
import { t } from '../../../i18n/i18n';
import { ProviderDiagnosticModal } from './ProviderDiagnosticModal';

export interface ProviderDiagnosticCardActions {
  onRetry?: () => void;
  onRebuildSession?: () => void;
}

export function renderProviderDiagnosticCard(
  container: HTMLElement,
  app: App,
  report: ProviderDiagnosticReport,
  actions: ProviderDiagnosticCardActions = {},
): HTMLElement {
  const card = container.createDiv({ cls: 'claudian-provider-diagnostic-card' });
  card.createDiv({
    cls: 'claudian-provider-diagnostic-card-title',
    text: `${report.providerId} · ${report.error.category.replaceAll('-', ' ')}`,
  });
  card.createDiv({
    cls: 'claudian-provider-diagnostic-card-message',
    text: report.error.message,
  });

  const footer = card.createDiv({ cls: 'claudian-provider-diagnostic-card-footer' });
  const detailButton = footer.createEl('button', {
    cls: 'mod-cta',
    text: t('settings.providerDiagnostics.details'),
  });
  detailButton.addEventListener('click', () => {
    new ProviderDiagnosticModal(app, report, actions.onRetry, actions.onRebuildSession).open();
  });

  if (report.error.category === 'session-resume-failed' && actions.onRebuildSession) {
    const rebuildButton = footer.createEl('button', {
      text: t('settings.providerDiagnostics.rebuild'),
    });
    rebuildButton.addEventListener('click', () => {
      card.remove();
      actions.onRebuildSession?.();
    });
  }
  if (report.error.recoverable && actions.onRetry) {
    const retryButton = footer.createEl('button', {
      text: t('settings.providerDiagnostics.retry'),
    });
    retryButton.addEventListener('click', () => {
      card.remove();
      actions.onRetry?.();
    });
  }

  container.insertBefore(card, container.firstChild);
  return card;
}
