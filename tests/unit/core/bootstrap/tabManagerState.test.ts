import { decodeTabWorkspaceViewState } from '@/core/bootstrap/tabManagerState';

describe('decodeTabWorkspaceViewState', () => {
  it('decodes a complete versioned view workspace', () => {
    expect(decodeTabWorkspaceViewState({
      version: 1,
      activeTabId: 'tab-2',
      openTabs: [
        { conversationId: 'conversation-1', tabId: 'tab-1', label: 'ACP restore' },
        { conversationId: null, draftModel: 'codex:gpt-5', tabId: 'tab-2' },
      ],
      expandedTitleTabIds: ['tab-2'],
    })).toEqual({
      activeTabId: 'tab-2',
      openTabs: [
        { conversationId: 'conversation-1', tabId: 'tab-1', label: 'ACP restore' },
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
    ...['', '   ', ' padded ', 42, null, 'x'.repeat(33)].map(label => ({
      version: 1,
      activeTabId: 'tab-1',
      openTabs: [
        { conversationId: null, tabId: 'tab-1', label: 'Valid' },
        { conversationId: null, tabId: 'tab-2', label },
      ],
    })),
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
      activeTabId: 'tab-1',
      openTabs: [
        { conversationId: null, tabId: 'tab-1' },
        { conversationId: null, tabId: 'tab-2', preview: true },
      ],
    },
    {
      version: 1,
      activeTabId: 'tab-1',
      openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1', preview: 'yes' }],
    },
    {
      version: 1,
      activeTabId: 'tab-1',
      openTabs: [{ conversationId: null, tabId: 'tab-1', preview: false }],
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

it('preserves a blank tab provider through versioned decoding', () => {
  const state = {
    activeTabId: 'draft',
    openTabs: [{ tabId: 'draft', conversationId: null, draftModel: 'retired-endpoint', providerId: 'codex' }],
  };
  expect(decodeTabWorkspaceViewState({ ...state, version: 1 })).toEqual(state);
});

it.each([null, 'codex'])('preserves explicit draft provider %s through snapshot decoding', providerId => {
  const state = { openTabs: [{ tabId: 'draft', conversationId: null, draftModel: 'retired', providerId }], activeTabId: 'draft' };
  expect(decodeTabWorkspaceViewState({ version: 1, ...state })).toEqual(state);
});

it.each([42, '', {}, undefined])('rejects a malformed explicit draft provider %s', providerId => {
  expect(decodeTabWorkspaceViewState({ version: 1, openTabs: [{ tabId: 'draft', conversationId: null, draftModel: 'retired', providerId }], activeTabId: 'draft' })).toBeNull();
});

it('preserves the active preview through versioned decoding', () => {
  const state = {
    activeTabId: 'draft',
    openTabs: [
      { tabId: 'retained', conversationId: 'conversation-1' },
      { tabId: 'draft', conversationId: null, draftModel: 'claude-default', providerId: 'claude', preview: true },
    ],
  };
  expect(decodeTabWorkspaceViewState({ ...state, version: 1 })).toEqual(state);
  const sessionPreview = {
    activeTabId: 'shown',
    openTabs: [{ tabId: 'shown', conversationId: 'conversation-2', preview: true }],
  };
  expect(decodeTabWorkspaceViewState({ ...sessionPreview, version: 1 })).toEqual(sessionPreview);
  expect(decodeTabWorkspaceViewState({ ...state, version: 1 })).toEqual(state);
});
