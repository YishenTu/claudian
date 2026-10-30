/** @vitest-environment jsdom */
import '@/providers';

import { createHarness as createExecutionHarness } from '@test/helpers/ChatExecutionHarness';
import { holdResponse } from '@test/helpers/ConversationPorts';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { conversationRecord } from '@test/helpers/features/chat/TabManagerTestHarness';
import { WorkspaceLeaf } from 'obsidian';

import type { ChatViewHost } from '@/features/chat/ChatFeatureHost';
import { ClaudianView } from '@/features/chat/ClaudianView';
import { resolveRowActions } from '@/features/chat/session-manager/SessionActions';
import { SessionNavigation } from '@/features/chat/session-manager/SessionNavigation';
import { TabManager } from '@/features/chat/tabs/TabManager';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

async function createNavigation() {
  const records = ['active', 'local', 'cross', 'shared'].map(id => conversationRecord(id));
  const views: ChatViewHost[] = [];
  const { plugin, pool } = await createSessionBrowserHost({ host: {
    executionPersistence: createExecutionHarness().repository,
    getConversationById: async id => records.find(record => record.id === id) ?? null,
    getConversationSummary: id => records.find(record => record.id === id) ?? null,
    getCachedConversation: id => records.find(record => record.id === id) ?? null,
    getConversationSync: id => records.find(record => record.id === id) ?? null,
    updateConversation: vi.fn().mockResolvedValue(undefined),
    getAllViews: () => views,
    findConversationAcrossViews: id => {
      for (const view of views) {
        const tab = view.getTabManager()?.getTabIdentities().find(tab => tab.conversationId === id);
        if (tab) return { view, tabId: tab.id };
      }
      return null;
    },
  } });
  const createPane = () => {
    const view = new ClaudianView(new WorkspaceLeaf(), plugin);
    const manager = new TabManager(plugin, document.body.createDiv(), view, {}, new VaultMentionDataProvider(plugin.app));
    Object.assign(view, { getTabManager: () => manager });
    views.push(view);
    onTestFinished(() => manager.destroy());
    return { view, manager, navigation: new SessionNavigation({ plugin, view, getTabManager: () => manager }) };
  };
  return { ...createPane(), plugin, pool, createPane };
}

afterEach(() => { document.body.replaceChildren(); });

it.each(['same-view', 'other-view'] as const)('disables archive for a running session bound in %s', async location => {
  const fixture = await createNavigation();
  const pane = location === 'same-view' ? fixture : fixture.createPane();
  const tab = await pane.manager.createTab('shared');
  expect(tab).not.toBeNull();
  const runtime = fixture.pool.get('shared')!;
  const release = holdResponse(runtime.turns);
  try {
    const status = fixture.navigation.getConversationStatus('shared');
    const actions = resolveRowActions('menu', {
      conversation: { ...conversationRecord('shared'), messageCount: 0, preview: '' }, status, attention: null,
    }, { sessionActionMode: 'active', onSelectConversation: vi.fn(), onRerender: vi.fn() });
    expect(status.openState).toBe(location === 'same-view' ? 'current' : 'open');
    expect(status.location).toBe(location === 'same-view' ? 'current-view' : 'other-view');
    expect(actions.find(action => action.kind === 'archive')).toEqual({ kind: 'archive', disabled: true });
  } finally { await release(); }
});

it('projects local and cross-view runtime attention into session status', async () => {
  const fixture = await createNavigation();
  const local = await fixture.manager.createTab('local');
  const active = await fixture.manager.createTab('active');
  const other = fixture.createPane();
  const cross = await other.manager.createTab('cross');
  expect([local, active, cross].every(Boolean)).toBe(true);
  const activeRuntime = fixture.pool.get('active')!;
  const localRuntime = fixture.pool.get('local')!;
  const crossRuntime = fixture.pool.get('cross')!;
  activeRuntime.attention.setActionRequired(true);
  localRuntime.attention.markReviewRequired('completed');
  crossRuntime.attention.markReviewRequired('error');
  const release = holdResponse(activeRuntime.turns);
  try {
    expect(fixture.navigation.getConversationStatus('active')).toMatchObject({
      attention: { kind: 'action-required', since: expect.any(Number) }, isRunning: true, openState: 'current',
    });
    expect(fixture.navigation.getConversationStatus('local')).toMatchObject({
      attention: { kind: 'review', outcome: 'completed', since: expect.any(Number) }, isRunning: false, openState: 'open',
    });
    expect(fixture.navigation.getConversationStatus('cross')).toMatchObject({
      attention: { kind: 'review', outcome: 'error', since: expect.any(Number) }, isRunning: false, location: 'other-view',
    });
    expect(fixture.navigation.getConversationStatus('closed').attention).toBeUndefined();
    // A stale lookup back to this pane does not make a closed session cross-view.
    const lookup = fixture.plugin.findConversationAcrossViews;
    fixture.plugin.findConversationAcrossViews = id => id === 'own-view'
      ? { view: fixture.view, tabId: 'tab-stale' } : lookup(id);
    expect(fixture.navigation.getConversationStatus('own-view')).toEqual({
      openState: 'closed', isRunning: false, location: 'current-view',
    });
  } finally { await release(); }
});
