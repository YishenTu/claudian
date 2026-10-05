import type { TabAttention } from '@/features/chat/state/types';

export type HistoryConversationOpenState = 'closed' | 'open' | 'current';

export type HistoryConversationStatus = {
  openState: HistoryConversationOpenState;
  isRunning: boolean;
  attention?: TabAttention;
  location?: 'current-view' | 'other-view';
  tabIndex?: number;
};

export type SessionStatusIndicatorKind = 'action-required' | 'error' | 'running';

/** Surface flags that decide how a session row presents its status. */
export interface SessionStatusDisplay {
  showAttentionState?: boolean;
  showOpenStateLabels?: boolean;
  sessionScope?: 'active' | 'archived';
}

const INDICATOR_PRESENTATION: Readonly<Record<SessionStatusIndicatorKind, {
  icon: string;
  label: string;
}>> = {
  'action-required': { icon: 'alert-circle', label: 'Needs your input' },
  error: { icon: 'x-circle', label: 'Stopped with an error' },
  running: { icon: 'loader-2', label: 'Running' },
};

/** Archived rows never present attention, even when their tab still carries it. */
export function canShowAttention(display: SessionStatusDisplay): boolean {
  return display.showAttentionState === true && display.sessionScope !== 'archived';
}

export function isCompletedReview(attention: TabAttention | undefined): boolean {
  return attention?.kind === 'review' && attention.outcome === 'completed';
}

/** Badges replace open-state labels; they only appear when the surface hides those labels. */
export function sessionIndicatorKind(
  status: HistoryConversationStatus,
  display: SessionStatusDisplay,
): SessionStatusIndicatorKind | null {
  if (display.showOpenStateLabels !== false) return null;

  const showAttention = canShowAttention(display);
  if (showAttention && status.attention?.kind === 'action-required') {
    return 'action-required';
  }
  if (status.isRunning) return 'running';
  if (
    showAttention
    && status.attention?.kind === 'review'
    && status.attention.outcome === 'error'
  ) {
    return 'error';
  }
  return null;
}

/** A group shows its most urgent member badge: waiting, then running, then error. */
export function groupIndicatorKind(
  statuses: readonly HistoryConversationStatus[],
  display: SessionStatusDisplay,
): SessionStatusIndicatorKind | null {
  const kinds = statuses.map(status => sessionIndicatorKind(status, display));
  if (kinds.includes('action-required')) return 'action-required';
  if (kinds.includes('running')) return 'running';
  if (kinds.includes('error')) return 'error';
  return null;
}

export function indicatorPresentation(kind: SessionStatusIndicatorKind): {
  icon: string;
  label: string;
} {
  return INDICATOR_PRESENTATION[kind];
}

export function sessionItemIcon(
  openState: HistoryConversationOpenState,
  isRunning: boolean,
): string {
  if (isRunning) return 'loader-2';
  if (openState === 'current') return 'message-square-dot';
  return 'message-square';
}

function tabLabel(status: HistoryConversationStatus): string {
  if (typeof status.tabIndex === 'number') return `tab ${status.tabIndex}`;
  if (status.openState === 'current') return 'current tab';
  return 'tab';
}

export function sessionStatusText(
  status: HistoryConversationStatus,
  timestamp: number,
  showOpenStateLabels: boolean,
): string {
  const { openState, isRunning } = status;
  const location = status.location ?? 'current-view';

  if (!showOpenStateLabels) return formatSessionDate(timestamp);

  if (openState !== 'closed' && location === 'other-view') {
    return isRunning ? 'Running in another pane' : 'Open in another pane';
  }

  if (isRunning) {
    if (openState === 'closed') return 'Running';
    return `Running in ${tabLabel(status)}`;
  }

  switch (openState) {
    case 'current':
      return typeof status.tabIndex === 'number'
        ? `Current tab ${status.tabIndex}`
        : 'Current session';
    case 'open':
      return `Open in ${tabLabel(status)}`;
    case 'closed':
      return formatSessionDate(timestamp);
  }
}

/** Today's sessions show their time; older sessions show their month and day. */
export function formatSessionDate(timestamp: number, now: Date = new Date()): string {
  const date = new Date(timestamp);
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
