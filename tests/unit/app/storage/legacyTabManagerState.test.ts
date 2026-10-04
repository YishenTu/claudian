import { normalizeTabManagerState } from '@/app/storage/legacyTabManagerState';

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

  it('deduplicates tab ids while preserving the first valid tab order', () => {
    const result = normalizeTabManagerState({
      openTabs: [
        { tabId: 'tab-1', conversationId: 'conv-1' },
        { tabId: 'tab-1', conversationId: 'conv-2' },
        { tabId: 'tab-2', conversationId: null, draftModel: 'codex:gpt-5' },
      ],
      activeTabId: 'tab-2',
    });

    expect(result?.openTabs).toEqual([
      { tabId: 'tab-1', conversationId: 'conv-1' },
      { tabId: 'tab-2', conversationId: null, draftModel: 'codex:gpt-5' },
    ]);
  });

  it('preserves a blank tab provider', () => {
    const state = {
      activeTabId: 'draft',
      openTabs: [{ tabId: 'draft', conversationId: null, draftModel: 'retired-endpoint', providerId: 'codex' }],
    };
    expect(normalizeTabManagerState(state)).toEqual(state);
  });
});
