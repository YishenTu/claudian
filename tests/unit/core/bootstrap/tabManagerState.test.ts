import { normalizeTabManagerState } from '@/core/bootstrap/tabManagerState';

describe('normalizeTabManagerState', () => {
  it('preserves valid expanded title tab ids', () => {
    const result = normalizeTabManagerState({
      openTabs: [
        { tabId: 'tab-1', conversationId: 'conv-1' },
        { tabId: 'tab-2', conversationId: null },
      ],
      activeTabId: 'tab-2',
      expandedTitleTabIds: ['tab-2', 'tab-1'],
    });

    expect(result).toEqual({
      openTabs: [
        { tabId: 'tab-1', conversationId: 'conv-1' },
        { tabId: 'tab-2', conversationId: null },
      ],
      activeTabId: 'tab-2',
      expandedTitleTabIds: ['tab-2', 'tab-1'],
    });
  });

  it('drops invalid, stale, and duplicate expanded title tab ids', () => {
    const result = normalizeTabManagerState({
      openTabs: [
        { tabId: 'tab-1', conversationId: null },
        { tabId: 'tab-2', conversationId: null },
      ],
      activeTabId: 'tab-1',
      expandedTitleTabIds: ['tab-2', 'missing-tab', 'tab-2', 7, 'tab-1'],
    });

    expect(result?.expandedTitleTabIds).toEqual(['tab-2', 'tab-1']);
  });
});
