/** @vitest-environment jsdom */
import { useNextTaskAnimationFrames } from '@test/helpers/dom/animationFrames';
import { registerChatTestProvider } from '@test/helpers/features/chat/ChatProviderFixture';
import { createManager, createPlugin, deferred, forkRequestFrom, holdHistory } from '@test/helpers/features/chat/TabManagerIntegrationHarness';
import { fireEvent, screen, within } from '@testing-library/dom';
import { Notice } from 'obsidian';

import type { ForkContext } from '@/features/chat/conversation/forkSourceTypes';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import { t } from '@/i18n/i18n';

const VIEWER_FORKS = { forkTarget: () => 'viewer' as const };
let provider: ReturnType<typeof registerChatTestProvider>;
beforeEach(() => {
  vi.clearAllMocks();
  useNextTaskAnimationFrames();
  provider = registerChatTestProvider('claude', { models: [{ value: 'claude-default', label: 'Claude' }] });
});

function forkContext(overrides: Partial<ForkContext> = {}): ForkContext {
  return { messages: [], providerId: 'claude', resumeAt: 'assistant-checkpoint', sourceConversationId: null, sourceSessionId: 'native-session', ...overrides };
}

function choose(target: 'new-tab' | 'current-tab' = 'new-tab') {
  const dialog = screen.getByRole('dialog', { name: t('chat.fork.chooseTarget') });
  fireEvent.click(within(dialog).getByRole('button', { name: t(target === 'new-tab' ? 'chat.fork.targetNewTab' : 'chat.fork.targetCurrentTab') }));
}

function holdProviderState() {
  const started = deferred<void>();
  const reply = deferred<Record<string, unknown>>();
  vi.spyOn(provider.history, 'buildForkProviderState').mockImplementationOnce(() => { started.resolve(); return reply.promise; });
  return { started: started.promise, release: () => reply.resolve({ fork: true }) };
}

it('preserves linked content, source project, messages, and provider state in a new fork', async () => {
  const { manager, plugin } = await createManager();
  const source = (await manager.createTab('source-conversation'))!;
  const messages: ForkContext['messages'] = [{ id: 'latest', role: 'assistant', content: 'Done', timestamp: Date.now() }];
  const fork = forkRequestFrom(manager, source)(forkContext({ linkedContentPath: 'Projects', projectId: 'project-1', messages, sourceConversationId: source.conversationId }));
  choose();
  await fork;
  expect(plugin.createConversation).toHaveBeenCalledWith(expect.objectContaining({ linkedContentPath: 'Projects', providerId: 'claude', projectId: 'project-1' }));
  expect(plugin.updateConversation).toHaveBeenCalledWith('forked', expect.objectContaining({ messages, providerState: { fork: true } }));
  expect(manager.getActiveTab()?.conversationId).toBe('forked');
  expect(manager.getTabCount()).toBe(2);
});

it.each(['rebind', 'shutdown'] as const)('aborts when the source is invalidated during provider-state creation (%s)', async invalidation => {
  const state = holdProviderState();
  const { manager, plugin } = await createManager();
  const source = (await manager.createTab('conversation-a'))!;
  const fork = forkRequestFrom(manager, source)(forkContext({ sourceConversationId: source.conversationId }));
  choose();
  await state.started;
  if (invalidation === 'rebind') await manager.openConversation('conversation-b');
  else source.session.runtime.beginShutdown();
  state.release();
  await fork;
  expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  expect(manager.getActiveTab()).toMatchObject({ id: source.id, conversationId: invalidation === 'rebind' ? 'conversation-b' : 'conversation-a' });
});

it('revalidates the fork lease after metadata persistence and before target side effects', async () => {
  const { manager, plugin } = await createManager();
  const source = (await manager.createTab('conversation-a'))!;
  const saving = deferred<void>();
  const saved = deferred<void>();
  vi.mocked(plugin.updateConversation).mockImplementationOnce(async () => { saving.resolve(); await saved.promise; });
  const fork = forkRequestFrom(manager, source)(forkContext({ sourceConversationId: source.conversationId }));
  choose();
  await saving.promise;
  source.session.beginClose();
  saved.resolve();
  await fork;
  expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  expect(manager.getAllTabs()).toEqual([source]);
});

it('aborts when its source rebinds while the real target chooser is open', async () => {
  const { manager, plugin } = await createManager();
  const source = (await manager.createTab('conversation-a'))!;
  const fork = forkRequestFrom(manager, source)(forkContext({ sourceConversationId: source.conversationId }));
  expect(screen.getByRole('dialog', { name: t('chat.fork.chooseTarget') }).isConnected).toBe(true);
  await manager.openConversation('conversation-b');
  choose('current-tab');
  await fork;
  expect(plugin.createConversation).not.toHaveBeenCalled();
  expect(manager.getActiveTab()?.conversationId).toBe('conversation-b');
});

it('shows a wide fork in the viewer without prompting or retaining a new tab', async () => {
  const { manager, plugin } = await createManager(await createPlugin(), {}, {}, VIEWER_FORKS);
  const source = (await manager.createTab('conversation-a'))!;
  await forkRequestFrom(manager, source)(forkContext({ sourceConversationId: source.conversationId }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(Notice).not.toHaveBeenCalled();
  expect(plugin.deleteConversation).not.toHaveBeenCalled();
  expect(manager.getActiveTab()).toMatchObject({ conversationId: 'forked', lifecycleState: 'provisional' });
  expect(manager.getPersistedState().openTabs.filter(tab => !tab.preview)).toEqual([{ tabId: source.id, conversationId: 'conversation-a' }]);
});

it('rejects a wide fork if the source shuts down during viewer hydration', async () => {
  const { manager, plugin } = await createManager(await createPlugin(), {}, {}, VIEWER_FORKS);
  const source = (await manager.createTab('conversation-a'))!;
  const hydration = holdHistory(plugin, 'forked');
  const fork = forkRequestFrom(manager, source)(forkContext({ sourceConversationId: source.conversationId }));
  await hydration.started;
  source.session.runtime.beginShutdown();
  hydration.release();
  await fork;
  expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  expect(manager.getAllTabs().some(tab => tab.conversationId === 'forked')).toBe(false);
});

it('deletes a wide fork that cannot be assembled', async () => {
  const { manager, plugin, root } = await createManager(await createPlugin(), {}, {}, VIEWER_FORKS);
  const source = (await manager.createTab())!;
  vi.spyOn(root, 'createDiv').mockImplementationOnce(() => { throw new Error('assembly failed'); });
  await expect(forkRequestFrom(manager, source)(forkContext())).rejects.toThrow('assembly failed');
  expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
});

it('keeps a forked tab when its post-commit observer throws', async () => {
  const { manager, plugin } = await createManager(await createPlugin(), { onTabCreated: tab => { if (tab.conversationId === 'forked') throw new Error('render failed'); } });
  const source = (await manager.createTab())!;
  const fork = forkRequestFrom(manager, source)(forkContext());
  choose();
  await fork;
  expect(manager.getAllTabs()).toHaveLength(2);
  expect(manager.getActiveTab()?.conversationId).toBe('forked');
  expect(plugin.deleteConversation).not.toHaveBeenCalled();
});

it('deletes a fork when manager destruction wins during provider-state creation', async () => {
  const state = holdProviderState();
  const { manager, plugin } = await createManager();
  const source = (await manager.createTab())!;
  const fork = forkRequestFrom(manager, source)(forkContext());
  choose();
  await state.started;
  await manager.destroy();
  state.release();
  await fork;
  expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  expect(manager.getAllTabs()).toEqual([]);
});

it.each([false, true])('compensates a fork hydrated after its source closes unless the user retained it (retained: %s)', async retainedByUser => {
  let forkTab: AssembledTabRuntime | undefined;
  const { manager, plugin } = await createManager(await createPlugin(), { onActiveTabChanged: (_from, to) => {
    const target = manager.getTab(to!);
    if (target?.conversationId === 'forked') {
      forkTab = target;
      if (retainedByUser) target.session.claimUserOwnership();
    }
  } });
  const retained = (await manager.createTab())!;
  const source = (await manager.createTab('source-conversation'))!;
  const hydration = holdHistory(plugin, 'forked');
  const fork = forkRequestFrom(manager, source)(forkContext({ sourceConversationId: source.conversationId }));
  choose();
  await hydration.started;
  await manager.closeTab(source.id);
  hydration.release();
  await fork;
  expect(forkTab).toBeDefined();
  expect(manager.getAllTabs()).toEqual(retainedByUser ? [retained, forkTab] : [retained]);
  expect(vi.mocked(plugin.deleteConversation).mock.calls).toEqual(retainedByUser ? [] : [['forked']]);
  expect(forkTab!.dom.contentEl.isConnected).toBe(retainedByUser);
});

it('keeps the fork conversation if compensation fails while its presentation remains live', async () => {
  const { manager, plugin, root } = await createManager();
  const source = (await manager.createTab())!;
  const hydration = holdHistory(plugin, 'forked');
  const fork = forkRequestFrom(manager, source)(forkContext());
  choose();
  await hydration.started;
  await manager.closeTab(source.id);
  vi.spyOn(root, 'createDiv').mockImplementationOnce(() => { throw new Error('Replacement assembly failed'); });
  hydration.release();
  await expect(fork).rejects.toThrow('Replacement assembly failed');
  expect(manager.getAllTabs()).toHaveLength(1);
  expect(manager.getActiveTab()?.conversationId).toBe('forked');
  expect(plugin.deleteConversation).not.toHaveBeenCalledWith('forked');
});

it('deletes a current-tab fork when the source closes during its hydration', async () => {
  const { manager, plugin } = await createManager();
  await manager.createTab();
  const source = (await manager.createTab())!;
  const hydration = holdHistory(plugin, 'forked');
  const fork = forkRequestFrom(manager, source)(forkContext());
  choose('current-tab');
  await hydration.started;
  await manager.closeTab(source.id);
  hydration.release();
  await fork;
  expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  expect(manager.getAllTabs().some(tab => tab.conversationId === 'forked')).toBe(false);
});

it('discards an uncommitted fork while its source has a reversible close claim', async () => {
  const { manager, plugin, root } = await createManager();
  const source = (await manager.createTab('source-conversation'))!;
  const hydration = holdHistory(plugin, 'forked');
  const fork = forkRequestFrom(manager, source)(forkContext({ sourceConversationId: source.conversationId }));
  choose('current-tab');
  await hydration.started;
  const replacementError = new Error('Replacement assembly failed');
  const rollingBack = deferred<void>();
  const rollback = deferred<void>();
  const createDiv = root.createDiv.bind(root);
  vi.spyOn(root, 'createDiv').mockImplementationOnce(options => {
    const el = createDiv(options);
    const remove = el.remove.bind(el);
    vi.spyOn(el, 'remove').mockImplementationOnce(async () => { rollingBack.resolve(); await rollback.promise; remove(); });
    vi.spyOn(el, 'createDiv').mockImplementationOnce(() => { throw replacementError; });
    return el;
  });
  const close = manager.discardTab(source.id);
  const closeResult = close.then(() => null, error => error);
  await rollingBack.promise;
  hydration.release();
  await fork;
  rollback.resolve();
  expect(await closeResult).toBe(replacementError);
  expect(manager.getActiveTab()?.conversationId).toBe('source-conversation');
  expect(source.session.acceptsIntents).toBe(true);
  expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
});

it('uses the real chooser to replace the current tab', async () => {
  const { manager, plugin } = await createManager();
  const source = (await manager.createTab())!;
  const fork = forkRequestFrom(manager, source)(forkContext());
  choose('current-tab');
  await fork;
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(manager.getActiveTab()).toMatchObject({ id: source.id, conversationId: 'forked' });
  expect(manager.getTabCount()).toBe(1);
  expect(plugin.deleteConversation).not.toHaveBeenCalled();
  expect(Notice).toHaveBeenCalled();
});

it.each(['metadata', 'provider-state'])('deletes a partial fork when %s persistence fails', async failure => {
  const { manager, plugin } = await createManager();
  const source = (await manager.createTab('source-conversation'))!;
  if (failure === 'metadata') vi.mocked(plugin.updateConversation).mockRejectedValueOnce(new Error('fork failed'));
  else vi.spyOn(provider.history, 'buildForkProviderState').mockRejectedValueOnce(new Error('fork failed'));
  const fork = forkRequestFrom(manager, source)(forkContext({ sourceConversationId: source.conversationId }));
  choose();
  await expect(fork).rejects.toThrow('fork failed');
  expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  expect(manager.getAllTabs()).toEqual([source]);
});
