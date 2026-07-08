/**
 * UsageLimitsMeter - toolbar button + popover showing account usage limits
 * (5-hour session window and weekly windows), mirroring the Claude app's
 * /usage display.
 */

import { setIcon } from 'obsidian';

import type { AccountUsageLimits, UsageLimitWindow } from '../../../core/usage/UsageLimitsService';
import { usageLimitsService } from '../../../core/usage/UsageLimitsService';
import { t } from '../../../i18n/i18n';

/** How the reset time is displayed: remaining countdown or absolute clock time. */
export type ResetDisplayMode = 'remaining' | 'absolute';

function formatRemaining(resetDate: Date): string {
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

function formatAbsolute(resetDate: Date): string {
  const now = new Date();
  const sameDay =
    resetDate.getFullYear() === now.getFullYear() &&
    resetDate.getMonth() === now.getMonth() &&
    resetDate.getDate() === now.getDate();

  const time = resetDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) {
    return t('chat.usageLimits.resetsAtTime', { time });
  }
  const day = resetDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return t('chat.usageLimits.resetsAtDay', { day, time });
}

function formatResetTime(resetsAt: string | null, mode: ResetDisplayMode): string | null {
  if (!resetsAt) {
    return null;
  }
  const resetDate = new Date(resetsAt);
  if (isNaN(resetDate.getTime())) {
    return null;
  }
  return mode === 'absolute' ? formatAbsolute(resetDate) : formatRemaining(resetDate);
}

function resolveResetDisplayMode(settings: Record<string, unknown> | null): ResetDisplayMode {
  const configs = settings?.providerConfigs;
  if (configs && typeof configs === 'object') {
    const claude = (configs as Record<string, unknown>)['claude'];
    if (claude && typeof claude === 'object') {
      const mode = (claude as Record<string, unknown>)['usageLimitsResetDisplay'];
      if (mode === 'absolute') {
        return 'absolute';
      }
    }
  }
  return 'remaining';
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
  private documentClickHandler: ((e: MouseEvent) => void) | null = null;
  private getSettings: (() => Record<string, unknown>) | null = null;

  constructor(parentEl: HTMLElement, getSettings?: () => Record<string, unknown>) {
    this.getSettings = getSettings ?? null;
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

    // No background polling: usage is fetched only when the user opens the
    // popover, so the plugin never talks to the network on its own.
  }

  setVisible(visible: boolean): void {
    this.container.toggleClass('claudian-hidden', !visible);
    if (!visible) {
      this.closePopover();
    }
  }

  destroy(): void {
    this.closePopover();
    this.container.remove();
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
    this.positionPopover();

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

  /**
   * Keep the popover fully inside the plugin's view container. The popover is
   * anchored to the left of its icon by default and shifted horizontally so it
   * never spills past the panel edges (important in the narrow side panel).
   */
  private positionPopover(): void {
    const popover = this.popoverEl;
    if (!popover) {
      return;
    }

    // The popover is created fresh on every open, so it starts at the CSS
    // default anchor (left: 0). We only ever add a dynamic horizontal shift.
    const view = this.container.closest('.view-content') as HTMLElement | null;
    const win = this.container.ownerDocument.defaultView;
    const boundRect = view
      ? view.getBoundingClientRect()
      : win
        ? { left: 0, right: win.innerWidth }
        : null;
    if (!boundRect) {
      return;
    }

    const margin = 8;

    // Never let the popover be wider than the available panel width.
    const available = boundRect.right - boundRect.left - margin * 2;
    if (available > 0) {
      popover.style.maxWidth = `${Math.max(180, Math.floor(available))}px`;
    }

    const rect = popover.getBoundingClientRect();
    let shift = 0;
    if (rect.right > boundRect.right - margin) {
      shift = boundRect.right - margin - rect.right;
    }
    if (rect.left + shift < boundRect.left + margin) {
      shift = boundRect.left + margin - rect.left;
    }
    if (shift !== 0) {
      popover.style.left = `${Math.round(shift)}px`;
    }
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

    const mode = resolveResetDisplayMode(this.getSettings ? this.getSettings() : null);
    const resetText = formatResetTime(window.resetsAt, mode);
    if (resetText) {
      rowEl.createDiv({ cls: 'claudian-usage-limits-row-reset', text: resetText });
    }
  }
}
