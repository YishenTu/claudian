import type { AppTabManagerState } from '@/core/bootstrap/tabManagerState';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Leniently decodes the retired plugin-global tab snapshot claimed once during migration. */
export function normalizeTabManagerState(data: unknown): AppTabManagerState | null {
  if (!isRecord(data) || !Array.isArray(data.openTabs)) {
    return null;
  }

  const openTabs: AppTabManagerState['openTabs'] = [];
  const openTabIds = new Set<string>();
  for (const tab of data.openTabs) {
    if (
      !isRecord(tab)
      || typeof tab.tabId !== 'string'
      || openTabIds.has(tab.tabId)
    ) {
      continue;
    }

    openTabs.push({
      tabId: tab.tabId,
      conversationId: typeof tab.conversationId === 'string' ? tab.conversationId : null,
      ...(typeof tab.draftModel === 'string'
        ? { draftModel: tab.draftModel }
        : {}),
      ...(tab.conversationId === null && isNonBlankString(tab.draftModel)
        && (isNonBlankString(tab.providerId) || tab.providerId === null)
        ? { providerId: tab.providerId } : {}),
    });
    openTabIds.add(tab.tabId);
  }

  const expandedTitleTabIds: string[] = [];
  const seenExpandedTabIds = new Set<string>();
  if (Array.isArray(data.expandedTitleTabIds)) {
    for (const tabId of data.expandedTitleTabIds) {
      if (
        typeof tabId !== 'string'
        || !openTabIds.has(tabId)
        || seenExpandedTabIds.has(tabId)
      ) {
        continue;
      }

      expandedTitleTabIds.push(tabId);
      seenExpandedTabIds.add(tabId);
    }
  }

  return {
    openTabs,
    activeTabId: typeof data.activeTabId === 'string' ? data.activeTabId : null,
    ...(expandedTitleTabIds.length > 0 ? { expandedTitleTabIds } : {}),
  };
}
