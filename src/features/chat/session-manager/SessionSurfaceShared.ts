import type { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import type { HistoryConversationStatus } from '@/features/chat/session-manager/SessionStatusPresentation';
import { scheduleAnimationFrame } from '@/features/chat/utils/animationFrame';

/** The session-opening policy the session manager presentations delegate to. */
export interface SessionSurfaceNavigation {
  getConversationStatus(conversationId: string): HistoryConversationStatus;
  openConversation(
    conversationId: string,
    options?: { preferNewTab: true; activate: boolean },
  ): Promise<void>;
  openSessionConversation(conversationId: string): Promise<void>;
  startLinkedContentConversation(contentPath: string): Promise<void>;
  contentExists(contentPath: string): boolean;
}

/**
 * What the history dropdown and the session sidebar share: one session browser
 * (selection, inline rename, metadata popover), the archive view, coalesced
 * invalidation, and first-render profiling. `SessionManagerSurface` owns it.
 */
export interface SessionSurfaceShared {
  readonly browser: SessionBrowser;
  isArchiveView(): boolean;
  /** Switches both presentations between active and archived sessions. */
  setArchiveView(isArchiveView: boolean): void;
  /** Marks both presentations stale and re-renders whichever is showing. */
  invalidate(): void;
  /** Runs a list render, profiling it when it is the first in either presentation. */
  profileListRender(render: () => void): void;
}

export interface InlineRenameRequest {
  beginRename: (item: HTMLElement) => void;
  conversationId: string;
}

/** Shows or hides a New control while keeping it out of the accessibility tree when hidden. */
export function setControlAvailability(button: HTMLElement | null, isAvailable: boolean): void {
  if (!button) return;

  button.toggleClass('claudian-hidden', !isAvailable);
  if (isAvailable) {
    button.removeAttribute('aria-disabled');
    button.removeAttribute('aria-hidden');
    return;
  }

  button.setAttribute('aria-disabled', 'true');
  button.setAttribute('aria-hidden', 'true');
}

/** List options that follow the archive view in both presentations. */
export function archiveScopeOptions(isArchiveView: boolean) {
  return {
    sessionScope: isArchiveView ? 'archived' : 'active',
    sessionActionMode: isArchiveView ? 'archived' : 'active',
    historyHeaderLabel: isArchiveView ? 'Archived' : 'Sessions',
    allowConversationSelection: !isArchiveView,
  } as const;
}

/**
 * Begins inline rename on the next frame, after the re-render the request
 * triggered, against the row that render produced for the conversation.
 */
export function beginInlineRenameNextFrame(
  container: HTMLElement,
  { beginRename, conversationId }: InlineRenameRequest,
  options: { isCurrent?: () => boolean; reveal?: () => void } = {},
): void {
  scheduleAnimationFrame(() => {
    if (options.isCurrent && !options.isCurrent()) return;
    const targetItem = Array.from(
      container.querySelectorAll<HTMLElement>('.claudian-history-item'),
    ).find(item => item.getAttribute('data-conversation-id') === conversationId);
    if (!targetItem) return;

    options.reveal?.();
    beginRename(targetItem);
  }, container.ownerDocument.defaultView);
}
