const LIST_SELECTOR = '.claudian-history-list';
const ITEM_SELECTOR = '.claudian-history-item';
/**
 * Rows a rerender keeps in place: sessions, and project headers, so expanding a project in a list that scrolls as
 * one keeps its header still instead of a session below it.
 */
const ANCHOR_SELECTOR = '.claudian-history-item[data-conversation-id], .claudian-session-group-header[data-project-id]';

type ScrollAnchor = {
  key: string;
  viewportOffset: number;
};

function anchorKey(element: HTMLElement): string | null {
  const conversationId = element.getAttribute('data-conversation-id');
  if (conversationId) return `conversation:${conversationId}`;
  const projectId = element.getAttribute('data-project-id');
  return projectId ? `project:${projectId}` : null;
}

/**
 * Scroll and pagination state of a rendered session list, carried across a rerender so the
 * rows the user was looking at stay in place. The loaded row count is recorded on the list
 * element itself, so a surface can extend it before requesting the rerender.
 */
export interface SessionListPosition {
  readonly visibleCount: number;
  readonly sessionScrollTop: number;
  readonly pinnedScrollTop: number;
  readonly projectsScrollTop: number;
  readonly anchors: readonly ScrollAnchor[];
}

export const INITIAL_SESSION_LIST_POSITION: SessionListPosition = {
  visibleCount: 0,
  sessionScrollTop: 0,
  pinnedScrollTop: 0,
  projectsScrollTop: 0,
  anchors: [],
};

function captureScrollAnchors(list: HTMLElement): ScrollAnchor[] {
  const listRect = list.getBoundingClientRect();
  if (listRect.height <= 0) return [];

  return Array.from(list.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR))
    .map((item): ScrollAnchor | null => {
      const key = anchorKey(item);
      const itemRect = item.getBoundingClientRect();
      if (
        !key
        || itemRect.height <= 0
        || itemRect.bottom <= listRect.top
        || itemRect.top >= listRect.bottom
      ) return null;
      return {
        key,
        viewportOffset: itemRect.top - listRect.top,
      };
    })
    .filter((anchor): anchor is ScrollAnchor => anchor !== null);
}

/**
 * Reads the position of the list currently rendered in `container`, before it is replaced. `sectionScrolling` says
 * whether its sections scroll on their own (the persistent sidebar) rather than the whole list (the compact menu).
 */
export function captureSessionListPosition(container: HTMLElement, sectionScrolling: boolean): SessionListPosition {
  const list = container.querySelector<HTMLElement>(LIST_SELECTOR);
  if (!list) return INITIAL_SESSION_LIST_POSITION;

  const sessionList = sectionScrolling
    ? list.querySelector<HTMLElement>('.claudian-session-list-items') ?? list
    : list;
  const pinnedList = list
    .querySelector<HTMLElement>('.claudian-history-section--pinned')
    ?.querySelector<HTMLElement>('.claudian-history-section-items');
  const projectsList = sectionScrolling
    ? list.querySelector<HTMLElement>('.claudian-session-project-items')
    : null;
  const recordedVisibleCount = Number(list.dataset.visibleCount);
  return {
    visibleCount: Number.isFinite(recordedVisibleCount) && recordedVisibleCount > 0
      ? recordedVisibleCount
      : list.querySelectorAll(ITEM_SELECTOR).length,
    sessionScrollTop: sessionList.scrollTop,
    pinnedScrollTop: pinnedList?.scrollTop ?? 0,
    projectsScrollTop: projectsList?.scrollTop ?? 0,
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
  projectsList: HTMLElement | null,
): void {
  if (projectsList) projectsList.scrollTop = position.projectsScrollTop;
  if (pinnedList) pinnedList.scrollTop = position.pinnedScrollTop;
  sessionList.scrollTop = position.sessionScrollTop;
  if (position.anchors.length === 0) return;

  const items = Array.from(sessionList.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR));
  const listTop = sessionList.getBoundingClientRect().top;
  for (const anchor of position.anchors) {
    const item = items.find(candidate => anchorKey(candidate) === anchor.key);
    if (!item) continue;

    const itemRect = item.getBoundingClientRect();
    if (itemRect.height <= 0) continue;
    sessionList.scrollTop += itemRect.top - listTop - anchor.viewportOffset;
    return;
  }
}
