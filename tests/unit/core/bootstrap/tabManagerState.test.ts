import {
  decodeTabWorkspaceViewState,
  normalizeTabManagerState,
  resolveTabRestorePlan,
} from '@/core/bootstrap/tabManagerState';

describe('decodeTabWorkspaceViewState', () => {
  it('decodes a complete versioned view workspace', () => {
    expect(decodeTabWorkspaceViewState({
      version: 1,
      activeTabId: 'tab-2',
      openTabs: [
        { conversationId: 'conversation-1', tabId: 'tab-1' },
        { conversationId: null, draftModel: 'codex:gpt-5', tabId: 'tab-2' },
      ],
      expandedTitleTabIds: ['tab-2'],
    })).toEqual({
      activeTabId: 'tab-2',
      openTabs: [
        { conversationId: 'conversation-1', tabId: 'tab-1' },
        { conversationId: null, draftModel: 'codex:gpt-5', tabId: 'tab-2' },
      ],
      expandedTitleTabIds: ['tab-2'],
    });
  });

  it.each([
    {
      version: 1,
      activeTabId: 'tab-1',
      openTabs: [
        { conversationId: null, tabId: 'tab-1' },
        { conversationId: null, tabId: 'tab-1' },
      ],
    },
    {
      version: 1,
      activeTabId: 'tab-1',
      openTabs: [
        { conversationId: null, tabId: 'tab-1' },
        { conversationId: 42, tabId: 'tab-2' },
      ],
    },
    {
      version: 1,
      activeTabId: 'missing-tab',
      openTabs: [{ conversationId: null, tabId: 'tab-1' }],
    },
    {
      version: 1,
      activeTabId: 'tab-1',
      openTabs: [{ conversationId: null, tabId: 'tab-1' }],
      expandedTitleTabIds: ['missing-tab'],
    },
    {
      version: 1,
      activeTabId: 'tab-1',
      openTabs: [
        { conversationId: null, tabId: 'tab-1' },
        { conversationId: '   ', tabId: 'tab-2' },
      ],
    },
    {
      version: 1,
      activeTabId: 'tab-1',
      openTabs: [
        { conversationId: null, tabId: 'tab-1' },
        { conversationId: null, draftModel: '\t', tabId: 'tab-2' },
      ],
    },
    {
      version: 1,
      activeTabId: '  ',
      openTabs: [{ conversationId: null, tabId: '  ' }],
    },
  ])('rejects the entire malformed versioned workspace', (state) => {
    expect(decodeTabWorkspaceViewState(state)).toBeNull();
  });
});

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
});

describe('resolveTabRestorePlan', () => {
  const state = {
    openTabs: [
      { tabId: 'tab-1', conversationId: 'conv-1' },
      { tabId: 'tab-2', conversationId: null, draftModel: 'codex:gpt-5' },
      { tabId: 'preview-tab', conversationId: 'conv-preview' },
    ],
    activeTabId: 'preview-tab',
    expandedTitleTabIds: ['tab-1', 'tab-2'],
  };

  it('returns an empty plan when startup restoration is disabled', () => {
    expect(resolveTabRestorePlan(state, {
      restoreTabsOnStartup: false,
      isDualPane: false,
    })).toEqual({
      openTabs: [],
      activeTabId: null,
    });
  });

  it('preserves every open tab and its order in single-pane mode', () => {
    expect(resolveTabRestorePlan(state, {
      restoreTabsOnStartup: true,
      isDualPane: false,
    })).toEqual(state);
  });

  it('selects only the last active tab in dual-pane mode', () => {
    expect(resolveTabRestorePlan(state, {
      restoreTabsOnStartup: true,
      isDualPane: true,
    })).toEqual({
      openTabs: [{ tabId: 'preview-tab', conversationId: 'conv-preview' }],
      activeTabId: 'preview-tab',
    });
  });

  it('returns an empty dual-pane plan when its active target is missing', () => {
    expect(resolveTabRestorePlan({ ...state, activeTabId: 'missing' }, {
      restoreTabsOnStartup: true,
      isDualPane: true,
    })).toEqual({
      openTabs: [],
      activeTabId: null,
    });
  });
});
