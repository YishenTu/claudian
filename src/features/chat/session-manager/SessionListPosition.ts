const LIST_SELECTOR = '.claudian-history-list';
const ITEM_SELECTOR = '.claudian-history-item';

type ScrollAnchor = {
  conversationId: string;
  viewportOffset: number;
};

/**
 * Scroll and pagination state of a rendered session list, carried across a rerender so the
 * rows the user was looking at stay in place. The loaded row count is recorded on the list
 * element itself, so a surface can extend it before requesting the rerender.
 */
export interface SessionListPosition {
  readonly visibleCount: number;
  readonly sessionScrollTop: number;
  readonly pinnedScrollTop: number;
  readonly anchors: readonly ScrollAnchor[];
}

export const INITIAL_SESSION_LIST_POSITION: SessionListPosition = {
  visibleCount: 0,
  sessionScrollTop: 0,
  pinnedScrollTop: 0,
  anchors: [],
};

function captureScrollAnchors(list: HTMLElement): ScrollAnchor[] {
  const listRect = list.getBoundingClientRect();
  if (listRect.height <= 0) return [];

  return Array.from(list.querySelectorAll<HTMLElement>(ITEM_SELECTOR))
    .map((item): ScrollAnchor | null => {
      const conversationId = item.getAttribute('data-conversation-id');
      const itemRect = item.getBoundingClientRect();
      if (
        !conversationId
        || itemRect.height <= 0
        || itemRect.bottom <= listRect.top
        || itemRect.top >= listRect.bottom
      ) return null;
      return {
        conversationId,
        viewportOffset: itemRect.top - listRect.top,
      };
    })
    .filter((anchor): anchor is ScrollAnchor => anchor !== null);
}

/** Reads the position of the list currently rendered in `container`, before it is replaced. */
export function captureSessionListPosition(container: HTMLElement): SessionListPosition {
  const list = container.querySelector<HTMLElement>(LIST_SELECTOR);
  if (!list) return INITIAL_SESSION_LIST_POSITION;

  const sessionList = list.querySelector<HTMLElement>('.claudian-session-list-items') ?? list;
  const pinnedList = list
    .querySelector<HTMLElement>('.claudian-history-section--pinned')
    ?.querySelector<HTMLElement>('.claudian-history-section-items');
  const recordedVisibleCount = Number(list.dataset.visibleCount);
  return {
    visibleCount: Number.isFinite(recordedVisibleCount) && recordedVisibleCount > 0
      ? recordedVisibleCount
      : list.querySelectorAll(ITEM_SELECTOR).length,
    sessionScrollTop: sessionList.scrollTop,
    pinnedScrollTop: pinnedList?.scrollTop ?? 0,
    anchors: captureScrollAnchors(sessionList),
  };
}

export function recordVisibleCount(list: HTMLElement, visibleCount: number): void {
  list.dataset.visibleCount = String(visibleCount);
}

/** Restores scroll after the new rows and any surface controls above them are in place. */
export function restoreSessionListPosition(
  position: SessionListPosition,
  sessionList: HTMLElement,
  pinnedList: HTMLElement | null,
): void {
  if (pinnedList) pinnedList.scrollTop = position.pinnedScrollTop;
  sessionList.scrollTop = position.sessionScrollTop;
  if (position.anchors.length === 0) return;

  const items = Array.from(sessionList.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
  const listTop = sessionList.getBoundingClientRect().top;
  for (const anchor of position.anchors) {
    const item = items.find(candidate => (
      candidate.getAttribute('data-conversation-id') === anchor.conversationId
    ));
    if (!item) continue;

    const itemRect = item.getBoundingClientRect();
    if (itemRect.height <= 0) continue;
    sessionList.scrollTop += itemRect.top - listTop - anchor.viewportOffset;
    return;
  }
}
