import type { ProviderId } from '../types/provider';
import { isValidSessionMetadataId } from './storagePaths';

/** Chat tab workspace state persisted per view across restarts. */
export interface AppTabManagerState {
  openTabs: Array<{
    tabId: string;
    conversationId: string | null;
    draftModel?: string;
    providerId?: ProviderId | null;
    /** User-chosen tab label; independent of the bound conversation's title. */
    label?: string;
    /** The active entry was the wide viewer's replaceable preview, not a retained tab. */
    preview?: true;
  }>;
  activeTabId: string | null;
  expandedTitleTabIds?: string[];
}

/** Longest custom tab label, in Unicode code points. */
export const TAB_LABEL_MAX_LENGTH = 32;

/** Trims and bounds a user-entered tab label; null clears the label. */
export function normalizeTabLabel(value: string): string | null {
  const label = Array.from(value.trim()).slice(0, TAB_LABEL_MAX_LENGTH).join('').trim();
  return label.length > 0 ? label : null;
}

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
      || ('providerId' in tab && (
        (!isNonBlankString(tab.providerId) && tab.providerId !== null)
        || tab.conversationId !== null || !isNonBlankString(tab.draftModel)
      ))
      || ('label' in tab && (typeof tab.label !== 'string' || normalizeTabLabel(tab.label) !== tab.label))
      || ('preview' in tab && (tab.preview !== true || tab.tabId !== data.activeTabId))
    ) {
      return null;
    }

    openTabs.push({
      tabId: tab.tabId,
      conversationId: tab.conversationId,
      ...(typeof tab.draftModel === 'string' ? { draftModel: tab.draftModel } : {}),
      ...('providerId' in tab ? { providerId: tab.providerId as string | null } : {}),
      ...(typeof tab.label === 'string' ? { label: tab.label } : {}),
      ...(tab.preview === true ? { preview: true as const } : {}),
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
