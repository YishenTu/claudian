/** @vitest-environment jsdom */
import { useNextTaskAnimationFrames } from '@test/helpers/dom/animationFrames';
import { registerChatTestProvider } from '@test/helpers/features/chat/ChatProviderFixture';
import { conversationRecord, createManager, createPlugin, deferred, holdHistory, navigationOwner } from '@test/helpers/features/chat/TabManagerIntegrationHarness';
import { fireEvent, within } from '@testing-library/dom';

import { BUILT_IN_COMMANDS } from '@/core/commands/builtInCommands';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';

beforeEach(() => {
  useNextTaskAnimationFrames();
  registerChatTestProvider('claude', { models: [{ value: 'claude-default', label: 'Claude' }] });
});

it('lets the layout open a session picked through the real tab command before rebinding the source', async () => {
  const picked = deferred<void>();
  const openPicked = vi.fn(async () => { picked.resolve(); return true; });
  const plugin = await createPlugin({ getConversationList: () => [{ ...conversationRecord('conversation-2'), messageCount: 0, preview: '' }] });
  const { manager } = await createManager(plugin, {}, {}, { openPicked });
  const source = (await manager.createTab('conversation-1'))!;
  await source.controllers.builtInCommandController.execute(BUILT_IN_COMMANDS.find(command => command.action === 'resume')!, ProviderRegistry.getCapabilities('claude'));
  fireEvent.click(within(source.dom.contentEl).getByText('conversation-2', { exact: true }));
  await picked.promise;
  await manager.waitForTabSwitchIdle();
  expect(openPicked).toHaveBeenCalledWith('conversation-2', source);
  expect(manager.getAllTabs()).toEqual([source]);
  expect(source.conversationId).toBe('conversation-1');
});

it('reuses an inactive conversation locally and closes another restored tab without assembling it', async () => {
  const { manager, root } = await createManager();
  await manager.restoreState({ openTabs: ['one', 'two', 'three'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' });
  await manager.closeTab('three');
  expect(manager.getAllTabs()).toHaveLength(1);
  expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(1);
  await manager.openConversation('two');
  expect(manager.getTabCount()).toBe(2);
  expect(manager.getActiveTabId()).toBe('two');
  expect(manager.getAllTabs()).toHaveLength(2);
});

it.each([false, true])('reuses a cold cross-view owner using its layout (wide: %s)', async wide => {
  const plugin = await createPlugin();
  const other = await createManager(plugin, {}, {}, { showsPreviews: () => wide });
  await other.manager.restoreState({ openTabs: ['one', 'two'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' });
  const local = await createManager(plugin);
  vi.spyOn(plugin, 'findConversationAcrossViews').mockImplementation(id => id === 'two' ? { tabId: 'two', view: other.view } : null);
  await local.manager.createTab(null, 'local');
  await local.manager.openConversation('two');
  expect(local.manager.getTabCount()).toBe(1);
  expect(local.manager.getTab('local')?.conversationId).toBeNull();
  expect(other.manager.getTab('two') === null).toBe(wide);
  expect(other.manager.getActiveTab()).toMatchObject({ conversationId: 'two', lifecycleState: wide ? 'provisional' : 'open' });
  expect(other.manager.getTabCount()).toBe(wide ? 3 : 2);
});

it('keeps a queued open-conversation intent bound to its source runtime', async () => {
  const { manager, plugin } = await createManager();
  const retained = (await manager.createTab())!;
  const source = (await manager.createTab())!;
  const hydration = holdHistory(plugin, 'blocking');
  const blocking = manager.openConversation('blocking');
  await hydration.started;
  const queued = navigationOwner(manager).open('stale-conversation', {}, source);
  await manager.closeTab(source.id);
  hydration.release();
  await Promise.all([blocking, queued]);
  expect(manager.getAllTabs()).toEqual([retained]);
  expect(retained.conversationId).toBeNull();
  expect(hydration.read.mock.calls.map(([id]) => id)).toEqual(['blocking']);
});

it('ignores a matching local tab after its close has begun', async () => {
  const { manager } = await createManager();
  const closing = (await manager.createTab('conversation-1'))!;
  const source = (await manager.createTab())!;
  const close = manager.closeTab(closing.id);
  await manager.openConversation('conversation-1');
  await close;
  expect(manager.getActiveTab()).toMatchObject({ id: source.id, conversationId: 'conversation-1' });
  expect(closing.dom.contentEl.isConnected).toBe(false);
});

it('falls back locally when an attached owner closes during its awaited reveal', async () => {
  const { manager, plugin } = await createManager();
  const source = (await manager.createTab())!;
  const target = (await manager.createTab('conversation-1', undefined, { activate: false }))!;
  const revealing = deferred<void>();
  const revealed = deferred<void>();
  vi.spyOn(plugin.app.workspace, 'revealLeaf').mockImplementationOnce(() => { revealing.resolve(); return revealed.promise; });
  const navigation = manager.openConversation('conversation-1');
  await revealing.promise;
  await manager.closeTab(target.id);
  revealed.resolve();
  await navigation;
  expect(manager.getActiveTab()).toMatchObject({ id: source.id, conversationId: 'conversation-1' });
});

it('accepts the attached owner while a close the manager does not own is only beginning', async () => {
  const { manager, plugin } = await createManager();
  const source = (await manager.createTab())!;
  const target = (await manager.createTab('conversation-1', undefined, { activate: false }))!;
  const hydration = holdHistory(plugin, 'conversation-1');
  const navigation = manager.openConversation('conversation-1');
  await hydration.started;
  target.session.beginClose();
  hydration.release();
  await navigation;
  expect(source.conversationId).toBeNull();
  expect(manager.getTabCount()).toBe(2);
  expect(plugin.pool.getAttachment('conversation-1')?.runtime).toBe(target.session.runtime);
});

it('uses a live replacement when the active tab is already closing', async () => {
  const replacementCreated = deferred<string>();
  const { manager } = await createManager(await createPlugin(), { onTabCreated: tab => { if (!tab.conversationId) replacementCreated.resolve(tab.id); } });
  const closing = (await manager.createTab('conversation-1'))!;
  const close = manager.closeTab(closing.id);
  const replacementId = await replacementCreated.promise;
  await manager.openConversation('conversation-2');
  await close;
  expect(manager.getActiveTab()).toMatchObject({ id: replacementId, conversationId: 'conversation-2' });
  expect(closing.conversationId).toBe('conversation-1');
});

async function crossView() {
  const plugin = await createPlugin();
  const other = await createManager(plugin);
  await other.manager.restoreState({ openTabs: [{ tabId: 'other-active', conversationId: null }, { tabId: 'other-target', conversationId: 'cross-view' }], activeTabId: 'other-active' });
  const local = await createManager(plugin);
  vi.spyOn(plugin, 'findConversationAcrossViews').mockImplementation(id => id === 'cross-view' ? { tabId: 'other-target', view: other.view } : null);
  return { plugin, other, local };
}

it('does not switch another view after a source-owned reveal loses its runtime', async () => {
  const { plugin, other, local } = await crossView();
  const retained = (await local.manager.createTab())!;
  const source = (await local.manager.createTab())!;
  const revealing = deferred<void>();
  const revealed = deferred<void>();
  vi.spyOn(plugin.app.workspace, 'revealLeaf').mockImplementationOnce(() => { revealing.resolve(); return revealed.promise; });
  const navigation = navigationOwner(local.manager).open('cross-view', {}, source);
  await revealing.promise;
  await local.manager.closeTab(source.id);
  revealed.resolve();
  await navigation;
  expect(other.manager.getActiveTabId()).toBe('other-active');
  expect(other.manager.getTab('other-target')).toBeNull();
  expect(local.manager.getAllTabs()).toEqual([retained]);
});

it('revalidates cross-view ownership after revealing the target', async () => {
  const { plugin, other, local } = await crossView();
  const source = (await local.manager.createTab())!;
  const revealing = deferred<void>();
  const revealed = deferred<void>();
  vi.spyOn(plugin.app.workspace, 'revealLeaf').mockImplementationOnce(() => { revealing.resolve(); return revealed.promise; });
  const navigation = navigationOwner(local.manager).open('cross-view', {}, source);
  await revealing.promise;
  await other.manager.closeTab('other-target');
  revealed.resolve();
  await navigation;
  expect(other.manager.getActiveTabId()).toBe('other-active');
  expect(local.manager.getActiveTab()).toMatchObject({ id: source.id, conversationId: 'cross-view' });
});

it('falls back locally when a cross-view target closes during its awaited focus', async () => {
  const { plugin, other, local } = await crossView();
  const source = (await local.manager.createTab())!;
  const hydration = holdHistory(plugin, 'cross-view');
  const navigation = local.manager.openConversation('cross-view');
  await hydration.started;
  const close = other.manager.closeTab('other-target');
  hydration.release();
  await Promise.all([navigation, close]);
  expect(local.manager.getActiveTab()).toMatchObject({ id: source.id, conversationId: 'cross-view' });
});

it('does not treat a close-claimed cold tab in another view as the owner', async () => {
  const { plugin, other, local } = await crossView();
  const localTab = (await local.manager.createTab())!;
  // Its inactive restored identity can be closed without ever constructing a provider runtime.
  const close = other.manager.closeTab('other-target');
  await local.manager.openConversation('cross-view');
  await close;
  expect(local.manager.getActiveTab()).toMatchObject({ id: localTab.id, conversationId: 'cross-view' });
  expect(other.manager.getTab('other-target')).toBeNull();
  expect(plugin.pool.getAttachment('cross-view')?.runtime).toBe(local.manager.getActiveTab()?.session.runtime);
});

it.each([false, true])('honors the latest navigation after an attached owner finishes closing (cross-view: %s)', async crossViewOwner => {
  const plugin = await createPlugin();
  const local = await createManager(plugin);
  const owner = crossViewOwner ? await createManager(plugin) : local;
  const target = (await owner.manager.createTab('closing'))!;
  await owner.manager.createTab();
  if (crossViewOwner) await local.manager.createTab();
  const cleaning = deferred<void>();
  const cleaned = deferred<void>();
  const remove = target.dom.inputEl.removeEventListener.bind(target.dom.inputEl);
  vi.spyOn(target.dom.inputEl, 'removeEventListener').mockImplementationOnce(async (...args) => {
    cleaning.resolve();
    await cleaned.promise;
    remove(...args);
  });
  const close = owner.manager.closeTab(target.id);
  await cleaning.promise;
  const revealing = deferred<void>();
  const attachment = plugin.pool.getAttachment('closing')!;
  const reveal = attachment.owner.reveal.bind(attachment.owner);
  vi.spyOn(attachment.owner, 'reveal').mockImplementation((isCurrent, options) => { revealing.resolve(); return reveal(isCurrent, options); });
  const first = local.manager.openConversation('closing');
  await revealing.promise;
  const latest = local.manager.openConversation('latest');
  cleaned.resolve();
  await Promise.all([close, first, latest]);
  expect(local.manager.getActiveTab()?.conversationId).toBe('latest');
  expect(owner.manager.getTab(target.id)).toBeNull();
  expect(plugin.pool.getAttachment('closing')).toBeNull();
});

it('joins a close whose successor activation is waiting for history, then reopens the released session', async () => {
  const { manager, plugin } = await createManager();
  const successor = (await manager.createTab('successor', undefined, { activate: false }))!;
  const closing = (await manager.createTab('closing'))!;
  const hydration = holdHistory(plugin, 'successor');
  const close = manager.closeTab(closing.id);
  await hydration.started;
  const navigation = manager.openConversation('closing');
  hydration.release();
  await Promise.all([close, navigation]);
  expect(manager.getActiveTab()).toMatchObject({ id: successor.id, conversationId: 'closing' });
  expect(closing.dom.contentEl.isConnected).toBe(false);
});

it('reopens locally after an already attached owner in another view completes its close', async () => {
  const plugin = await createPlugin();
  const other = await createManager(plugin);
  const closing = (await other.manager.createTab('cross-view'))!;
  await other.manager.createTab();
  const local = await createManager(plugin);
  const source = (await local.manager.createTab())!;
  const close = other.manager.closeTab(closing.id);
  await local.manager.openConversation('cross-view');
  await close;
  expect(local.manager.getActiveTab()).toMatchObject({ id: source.id, conversationId: 'cross-view' });
  expect(other.manager.getTab(closing.id)).toBeNull();
  expect(plugin.pool.getAttachment('cross-view')?.runtime).toBe(local.manager.getActiveTab()?.session.runtime);
});

it('does not join its own close while a duplicate cold successor tries to reveal that attachment', async () => {
  const { manager } = await createManager();
  await manager.restoreState({ openTabs: [
    { tabId: 'one', conversationId: 'same-conversation' },
    { tabId: 'two', conversationId: 'same-conversation' },
  ], activeTabId: 'one' });
  await expect(manager.closeTab('one')).resolves.toBe(false);
  expect(manager.getActiveTabId()).toBe('one');
  expect(manager.getTab('one')?.session.acceptsIntents).toBe(true);
});
