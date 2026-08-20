import type { AppTabManagerState } from '../providers/types';
import { isValidSessionMetadataId } from './SessionStorage';

export const TAB_WORKSPACE_VIEW_STATE_KEY = 'tabWorkspace';
export const TAB_WORKSPACE_VIEW_STATE_VERSION = 1;
export type TabWorkspaceViewState = AppTabManagerState & {
  version: typeof TAB_WORKSPACE_VIEW_STATE_VERSION;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function decodeTabWorkspaceViewState(data: unknown): AppTabManagerState | null {
  if (
    !isRecord(data)
    || data.version !== TAB_WORKSPACE_VIEW_STATE_VERSION
    || !Array.isArray(data.openTabs)
    || (data.activeTabId !== null && !isNonBlankString(data.activeTabId))
  ) {
    return null;
  }

  const openTabs: AppTabManagerState['openTabs'] = [];
  const openTabIds = new Set<string>();
  for (const tab of data.openTabs) {
    if (
      !isRecord(tab)
      || !isNonBlankString(tab.tabId)
      || openTabIds.has(tab.tabId)
      || (
        tab.conversationId !== null
        && (
          !isNonBlankString(tab.conversationId)
          || !isValidSessionMetadataId(tab.conversationId)
        )
      )
      || (
        'draftModel' in tab
        && !isNonBlankString(tab.draftModel)
      )
      || (
        typeof tab.conversationId === 'string'
        && 'draftModel' in tab
      )
    ) {
      return null;
    }

    openTabs.push({
      tabId: tab.tabId,
      conversationId: tab.conversationId,
      ...(typeof tab.draftModel === 'string' ? { draftModel: tab.draftModel } : {}),
    });
    openTabIds.add(tab.tabId);
  }

  if (data.activeTabId !== null && !openTabIds.has(data.activeTabId)) {
    return null;
  }
  if (openTabs.length > 0 && data.activeTabId === null) {
    return null;
  }

  const expandedTitleTabIds: string[] = [];
  if ('expandedTitleTabIds' in data) {
    if (!Array.isArray(data.expandedTitleTabIds)) return null;

    const seenExpandedTabIds = new Set<string>();
    for (const tabId of data.expandedTitleTabIds) {
      if (
        !isNonBlankString(tabId)
        || !openTabIds.has(tabId)
        || seenExpandedTabIds.has(tabId)
      ) {
        return null;
      }
      expandedTitleTabIds.push(tabId);
      seenExpandedTabIds.add(tabId);
    }
  }

  return {
    openTabs,
    activeTabId: data.activeTabId,
    ...(expandedTitleTabIds.length > 0 ? { expandedTitleTabIds } : {}),
  };
}

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

export function resolveTabRestorePlan(
  state: AppTabManagerState | null,
  options: {
    restoreTabsOnStartup: boolean;
    isDualPane: boolean;
  },
): AppTabManagerState {
  if (!state || !options.restoreTabsOnStartup) {
    return { openTabs: [], activeTabId: null };
  }

  if (options.isDualPane) {
    const activeTab = state.openTabs.find(tab => tab.tabId === state.activeTabId);
    return activeTab
      ? {
          openTabs: [activeTab],
          activeTabId: activeTab.tabId,
          ...(state.expandedTitleTabIds?.includes(activeTab.tabId)
            ? { expandedTitleTabIds: [activeTab.tabId] }
            : {}),
        }
      : { openTabs: [], activeTabId: null };
  }

  const activeTabId = state.openTabs.some(tab => tab.tabId === state.activeTabId)
    ? state.activeTabId
    : state.openTabs[0]?.tabId ?? null;
  return {
    openTabs: [...state.openTabs],
    activeTabId,
    ...(state.expandedTitleTabIds?.length
      ? { expandedTitleTabIds: [...state.expandedTitleTabIds] }
      : {}),
  };
}
