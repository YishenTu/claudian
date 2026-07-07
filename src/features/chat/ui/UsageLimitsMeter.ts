/**
 * UsageLimitsMeter - toolbar button + popover showing account usage limits
 * (5-hour session window and weekly windows), mirroring the Claude app's
 * /usage display.
 */

import { setIcon } from 'obsidian';

import type { AccountUsageLimits, UsageLimitWindow } from '../../../core/usage/UsageLimitsService';
import { usageLimitsService } from '../../../core/usage/UsageLimitsService';
import { t } from '../../../i18n/i18n';

const AUTO_REFRESH_MS = 5 * 60_000;

function formatResetTime(resetsAt: string | null): string | null {
  if (!resetsAt) {
    return null;
  }
  const resetDate = new Date(resetsAt);
  if (isNaN(resetDate.getTime())) {
    return null;
  }

  const remainingMs = resetDate.getTime() - Date.now();
  if (remainingMs <= 0) {
    return t('chat.usageLimits.resetsSoon');
  }

  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return t('chat.usageLimits.resetsInDays', { days, hours });
  }
  if (hours > 0) {
    return t('chat.usageLimits.resetsInHours', { hours, minutes });
  }
  return t('chat.usageLimits.resetsInMinutes', { minutes });
}

function severityClass(utilization: number): string {
  if (utilization >= 90) {
    return 'is-critical';
  }
  if (utilization >= 70) {
    return 'is-warning';
  }
  return 'is-normal';
}

export class UsageLimitsMeter {
  private container: HTMLElement;
  private iconEl: HTMLElement;
  private popoverEl: HTMLElement | null = null;
  private refreshTimer: number | null = null;
  private documentClickHandler: ((e: MouseEvent) => void) | null = null;

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'claudian-usage-limits' });

    this.iconEl = this.container.createDiv({
      cls: 'claudian-usage-limits-icon',
      attr: {
        'role': 'button',
        'tabindex': '0',
        'aria-label': t('chat.usageLimits.buttonLabel'),
        'title': t('chat.usageLimits.buttonLabel'),
      },
    });
    setIcon(this.iconEl, 'gauge');

    this.iconEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePopover();
    });
    this.iconEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.togglePopover();
      }
    });

    // Keep the tooltip badge fresh in the background (cheap: cached snapshot).
    this.scheduleBackgroundRefresh();
  }

  setVisible(visible: boolean): void {
    this.container.toggleClass('claudian-hidden', !visible);
    if (!visible) {
      this.closePopover();
    }
  }

  destroy(): void {
    this.closePopover();
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.container.remove();
  }

  private scheduleBackgroundRefresh(): void {
    const refresh = () => {
      void usageLimitsService
        .getLimits()
        .then((limits) => this.updateBadge(limits))
        .catch(() => {
          /* silently ignore in background */
        });
    };
    refresh();
    this.refreshTimer = window.setInterval(refresh, AUTO_REFRESH_MS);
  }

  private updateBadge(limits: AccountUsageLimits): void {
    const session = limits.session;
    if (session) {
      this.iconEl.toggleClass('is-warning', session.utilization >= 70 && session.utilization < 90);
      this.iconEl.toggleClass('is-critical', session.utilization >= 90);
      this.iconEl.setAttribute(
        'title',
        `${t('chat.usageLimits.sessionLabel')}: ${session.utilization}%`,
      );
    }
  }

  private togglePopover(): void {
    if (this.popoverEl) {
      this.closePopover();
    } else {
      this.openPopover();
    }
  }

  private openPopover(): void {
    this.popoverEl = this.container.createDiv({ cls: 'claudian-usage-limits-popover' });
    this.renderLoading();

    this.documentClickHandler = (e: MouseEvent) => {
      if (this.popoverEl && !this.container.contains(e.target as Node)) {
        this.closePopover();
      }
    };
    this.container.ownerDocument.addEventListener('click', this.documentClickHandler);

    void usageLimitsService
      .getLimits(true)
      .then((limits) => {
        this.updateBadge(limits);
        this.renderLimits(limits);
      })
      .catch((error: unknown) => {
        this.renderError(error);
      });
  }

  private closePopover(): void {
    if (this.documentClickHandler) {
      this.container.ownerDocument.removeEventListener('click', this.documentClickHandler);
      this.documentClickHandler = null;
    }
    this.popoverEl?.remove();
    this.popoverEl = null;
  }

  private renderLoading(): void {
    if (!this.popoverEl) {
      return;
    }
    this.popoverEl.empty();
    this.popoverEl.createDiv({
      cls: 'claudian-usage-limits-loading',
      text: t('chat.usageLimits.loading'),
    });
  }

  private renderError(error: unknown): void {
    if (!this.popoverEl) {
      return;
    }
    this.popoverEl.empty();
    const message =
      error instanceof Error && error.message === 'credentials-not-found'
        ? t('chat.usageLimits.errorNoCredentials')
        : t('chat.usageLimits.errorFetch');
    this.popoverEl.createDiv({ cls: 'claudian-usage-limits-error', text: message });
  }

  private renderLimits(limits: AccountUsageLimits): void {
    if (!this.popoverEl) {
      return;
    }
    this.popoverEl.empty();

    this.popoverEl.createDiv({
      cls: 'claudian-usage-limits-title',
      text: t('chat.usageLimits.title'),
    });

    const rows: { label: string; window: UsageLimitWindow | null }[] = [
      { label: t('chat.usageLimits.sessionLabel'), window: limits.session },
      { label: t('chat.usageLimits.weeklyLabel'), window: limits.weekly },
      { label: t('chat.usageLimits.weeklyScopedLabel'), window: limits.weeklyScoped },
    ];

    let rendered = 0;
    for (const row of rows) {
      if (!row.window) {
        continue;
      }
      rendered++;
      this.renderRow(this.popoverEl, row.label, row.window);
    }

    if (rendered === 0) {
      this.popoverEl.createDiv({
        cls: 'claudian-usage-limits-error',
        text: t('chat.usageLimits.errorFetch'),
      });
    }
  }

  private renderRow(parentEl: HTMLElement, label: string, window: UsageLimitWindow): void {
    const rowEl = parentEl.createDiv({ cls: 'claudian-usage-limits-row' });

    const headerEl = rowEl.createDiv({ cls: 'claudian-usage-limits-row-header' });
    headerEl.createSpan({ cls: 'claudian-usage-limits-row-label', text: label });
    headerEl.createSpan({
      cls: 'claudian-usage-limits-row-percent',
      text: t('chat.usageLimits.percentUsed', { percent: window.utilization }),
    });

    const barEl = rowEl.createDiv({ cls: 'claudian-usage-limits-bar' });
    const fillEl = barEl.createDiv({
      cls: `claudian-usage-limits-bar-fill ${severityClass(window.utilization)}`,
    });
    fillEl.style.width = `${window.utilization}%`;

    const resetText = formatResetTime(window.resetsAt);
    if (resetText) {
      rowEl.createDiv({ cls: 'claudian-usage-limits-row-reset', text: resetText });
    }
  }
}
