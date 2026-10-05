import { setIcon } from 'obsidian';

import type { ToolCallInfo } from '@/core/types';

const STATUS_ICONS: Partial<Record<ToolCallInfo['status'], string>> = {
  completed: 'check',
  error: 'x',
  blocked: 'shield-off',
};

/** Replaces a tool status indicator's class, label and icon; running shows no icon. */
export function setToolStatus(
  statusEl: HTMLElement,
  status: ToolCallInfo['status'],
  baseClass: string,
  ariaLabel = `Status: ${status}`,
): void {
  statusEl.className = baseClass;
  statusEl.empty();
  statusEl.addClass(`status-${status}`);
  statusEl.setAttribute('aria-label', ariaLabel);
  const icon = STATUS_ICONS[status];
  if (icon) setIcon(statusEl, icon);
}
