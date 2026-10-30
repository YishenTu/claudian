/** @vitest-environment jsdom */
import { useNextTaskAnimationFrames } from '@test/helpers/dom/animationFrames';
import type { ChatFeatureHostOverrides } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { registerChatTestProvider } from '@test/helpers/features/chat/ChatProviderFixture';
import { conversationRecord, createManager, createPlugin, deferred, holdHistory } from '@test/helpers/features/chat/TabManagerIntegrationHarness';
import { App, TFile } from 'obsidian';

import { BUILT_IN_COMMANDS } from '@/core/commands/builtInCommands';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { TabManager } from '@/features/chat/tabs/TabManager';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

let provider: ReturnType<typeof registerChatTestProvider>;
beforeEach(() => {
  useNextTaskAnimationFrames();
  provider = registerChatTestProvider('claude', { models: [{ value: 'claude-default', label: 'Claude' }] });
});
const conversationPlugin = createPlugin;
const shownDraft = (manager: TabManager) => manager.getActiveTab()!.controllers.drafts.capture('main').content;
async function linkedContentPlugin(paths: string[], overrides: ChatFeatureHostOverrides = {}) {
  const files = new Set(paths);
  const app = new App();
  app.vault.getAbstractFileByPath = path => files.has(path) ? Object.assign(new TFile(), { path }) : null;
  return { files, plugin: await createPlugin({ app, ...overrides }) };
}
async function runNew(tab: AssembledTabRuntime) {
  await tab.controllers.builtInCommandController.execute(BUILT_IN_COMMANDS.find(command => command.action === 'clear')!, ProviderRegistry.getCapabilities(tab.providerId!));
}

it('discards inactive previews without removing open runtime tabs', async () => {
    const getCachedConversation = vi.fn((id: string) => (conversationRecord(id, { providerId: 'claude' })));
    const { manager } = await createManager(await createPlugin({ getCachedConversation }));
    const first = await manager.createTab('conversation-1');
    const second = await manager.createTab('conversation-2', undefined, { activate: false });
    await manager.viewerSlot.show('conversation-3');
    await manager.switchToTab(first!.id);

    await manager.viewerSlot.release();

    expect(manager.getAllTabs()).toEqual([first, second]);
    expect(manager.getAllTabs().every(tab => tab.dom.contentEl.isConnected)).toBe(true);
  });

it('retains the active preview when it is the only tab', async () => {
    const { manager } = await createManager(await createPlugin({
      getCachedConversation: (id: string) => (conversationRecord(id, { providerId: 'claude' })),
    }));
    await manager.viewerSlot.show('conversation-1');
    const preview = manager.getActiveTab()!;
    expect(preview.lifecycleState).toBe('provisional');

    await manager.viewerSlot.release();

    expect(manager.getAllTabs()).toEqual([preview]);
    expect(preview.lifecycleState).toBe('open');
    expect(preview.dom.contentEl.isConnected).toBe(true);
  });

it('keeps the shown preview as a tab when leaving wide', async () => {
    const { manager } = await createManager(await conversationPlugin());
    const retained = await manager.createTab('conversation-1');
    await manager.viewerSlot.show('conversation-2');
    const preview = manager.getActiveTab()!;
    expect(preview.lifecycleState).toBe('provisional');

    await manager.viewerSlot.release();

    expect(manager.getAllTabs()).toEqual([retained, preview]);
    expect(preview.lifecycleState).toBe('open');
    expect(manager.getActiveTabId()).toBe(preview.id);
  });

it('returns to the last active retained tab when the active preview closes', async () => {
    const { manager } = await createManager(await conversationPlugin());
    const lastActive = await manager.createTab('conversation-1');
    const neighbour = await manager.createTab('conversation-2', undefined, { activate: false });
    await manager.viewerSlot.show('conversation-3');
    const preview = manager.getActiveTab()!;

    await manager.closeTab(preview.id);

    expect(manager.getAllTabs()).toEqual([lastActive, neighbour]);
    expect(manager.getActiveTabId()).toBe(lastActive!.id);
  });

it("returns a new session's unsent text when another draft starts", async () => {
    const { manager } = await createManager(await conversationPlugin());
    await manager.viewerSlot.startDraft();
    manager.getActiveTab()!.controllers.drafts.restore('main', { content: 'new idea' });

    await manager.viewerSlot.show('conversation-1');
    expect(manager.getActiveTab()!.controllers.drafts.capture('main').content).toBe('');
    manager.getActiveTab()!.controllers.drafts.restore('main', { content: 'conversation idea' });
    await manager.viewerSlot.startDraft();

    const draft = manager.getActiveTab()!;
    expect(draft.conversationId).toBeNull();
    expect(draft.controllers.drafts.capture('main').content).toBe('new idea');
    expect(manager.getAllTabs()).toEqual([draft]);
    await manager.viewerSlot.show('conversation-1');
    expect(manager.getActiveTab()!.controllers.drafts.capture('main').content).toBe('conversation idea');
  });

it('replaces a closed active preview with a draft instead of a narrow tab', async () => {
      const { manager } = await createManager(await conversationPlugin(), {}, {}, { showsPreviews: () => true });
      const narrow = await manager.createTab('conversation-1');
      await manager.viewerSlot.enter();
      await manager.viewerSlot.show('conversation-2');

      await manager.closeTab(manager.getActiveTabId()!);

      expect(manager.getTab(narrow!.id)).toBeNull();
      expect(manager.getAllTabs()).toEqual([manager.getActiveTab()]);
      expect(manager.getActiveTab()).toEqual(expect.objectContaining({ conversationId: null, lifecycleState: 'provisional' }));
    });

it('enters wide again after a release that overlapped the request', async () => {
      const { manager } = await createManager(await conversationPlugin());
      const narrow = await manager.createTab('conversation-1');
      await manager.viewerSlot.enter();

      await Promise.all([manager.viewerSlot.release(), manager.viewerSlot.enter()]);

      expect(manager.getTab(narrow!.id)).toBeNull();
      expect(manager.getActiveTab()).toEqual(expect.objectContaining({
        conversationId: 'conversation-1', lifecycleState: 'provisional',
      }));
    });

it("seeds a cold wide restore's new session from the saved blank tab selection", async () => {
      const { manager } = await createManager(await conversationPlugin(), {}, {}, { showsPreviews: () => true });

      await manager.restoreState({
        openTabs: [{ tabId: 'draft', conversationId: null, draftModel: 'codex:gpt-5', providerId: 'codex' }],
        activeTabId: 'draft',
      });

      const preview = manager.getActiveTab()!;
      expect([preview.lifecycleState, preview.draftModel, preview.providerId]).toEqual(['provisional', 'codex:gpt-5', 'codex']);
    });

it('keeps unsent text with a draft session that creates its conversation while unloaded', async () => {
      const { manager } = await createManager(await conversationPlugin());
      const blank = await manager.createTab(null);
      await manager.viewerSlot.enter();
      const session = manager.getActiveTab()!.session.runtime;
      manager.getActiveTab()!.controllers.drafts.restore('main', { content: 'follow-up' });
      await manager.viewerSlot.show('conversation-1');

      session.setConversationId('created');
      manager.reconcileUnloadedSessions();
      await manager.viewerSlot.release();
      await manager.switchToTab(blank!.id);

      expect(manager.getActiveTab()!.session.runtime).toBe(session);
      expect(shownDraft(manager)).toBe('follow-up');
    });

it('publishes a wide project draft already seeded, so a first input cannot outrun the seed', async () => {
      const seedsWhenActivated: unknown[] = [];
      const { manager } = await createManager(await conversationPlugin(), {
        onActiveTabChanged: () => {
          const tab = manager.getActiveTab();
          if (tab && !tab.conversationId) {
            seedsWhenActivated.push((tab.controllers.conversationController).project.projectId);
          }
        },
      });
      await manager.createTab(null);
      await manager.viewerSlot.enter();
      seedsWhenActivated.length = 0;

      await manager.viewerSlot.startDraft({ projectId: 'project-1' });
      expect(seedsWhenActivated).toEqual(['project-1']);
    });

it('starts a project-seeded draft in the compact active tab, as New does there', async () => {
      const { manager } = await createManager(await conversationPlugin());
      const bound = await manager.createTab('conversation-1');
      const draftProject = () => (manager.getActiveTab()!.controllers.conversationController).project.projectId;

      await manager.createNewConversation({ projectId: 'project-1' });
      const tab = manager.getActiveTab()!;
      expect([manager.getTabCount(), tab.conversationId, draftProject()]).toEqual([1, null, 'project-1']);
      expect(tab.session.runtime === bound!.session.runtime).toBe(false);
    });

it('publishes a compact project draft already seeded, so a first input cannot outrun the seed', async () => {
      const seedsWhenActivated: unknown[] = [];
      const { manager } = await createManager(await conversationPlugin(), {
        onActiveTabChanged: () => {
          const tab = manager.getActiveTab();
          if (tab && !tab.conversationId) {
            seedsWhenActivated.push((tab.controllers.conversationController).project.projectId);
          }
        },
      });
      await manager.createTab('conversation-1');

      await manager.createNewConversation({ projectId: 'project-1' });
      expect(seedsWhenActivated).toEqual(['project-1']);
    });

it('returns to a blank draft only for the same project, and the seed follows its session leaving wide', async () => {
      const { manager } = await createManager(await conversationPlugin());
      await manager.createTab(null);
      await manager.viewerSlot.enter();
      const blankSession = manager.getActiveTab()!.session.runtime;
      const draftProject = () => (manager.getActiveTab()!.controllers.conversationController).project.projectId;

      await manager.viewerSlot.startDraft({ projectId: 'project-1' });
      const session = manager.getActiveTab()!.session.runtime;
      expect([session === blankSession, draftProject()]).toEqual([false, 'project-1']);

      // New for the same project returns to its blank draft; New outside it never brings that draft back.
      await manager.viewerSlot.show('conversation-1');
      await manager.viewerSlot.startDraft();
      expect([manager.getActiveTab()!.session.runtime === session, draftProject()]).toEqual([false, undefined]);
      await manager.viewerSlot.startDraft({ projectId: 'project-1' });
      expect([manager.getActiveTab()!.session.runtime === session, draftProject()]).toEqual([true, 'project-1']);

      await manager.viewerSlot.release();
      const narrow = manager.getActiveTab()!;
      expect([narrow.lifecycleState, narrow.session.runtime === session, draftProject()]).toEqual(['open', true, 'project-1']);
    });

it('returns to the same new session when New follows browsing another session', async () => {
      const { manager } = await createManager(await conversationPlugin());
      await manager.viewerSlot.startDraft();
      const session = manager.getActiveTab()!.session.runtime;
      manager.getActiveTab()!.controllers.drafts.restore('main', { content: 'new idea' });

      await manager.viewerSlot.show('conversation-1');
      await manager.viewerSlot.startDraft();

      expect(manager.getActiveTab()!.session.runtime).toBe(session);
      expect(shownDraft(manager)).toBe('new idea');
    });

it('re-links the focused Note whenever New returns to the new session, keeping its text', async () => {
      let activeFile: TFile | null = Object.assign(new TFile(), { path: 'Notes/A.md', extension: 'md' });
      const focus = (path: string) => { activeFile = Object.assign(new TFile(), { path, extension: 'md' }); };
      const plugin = await conversationPlugin();
      plugin.app.workspace.getActiveFile = () => activeFile;
      const { manager } = await createManager(plugin);
      const shownLink = () => manager.getActiveTab()!.session.runtime.model.linkedContentController.getSnapshot();

      await manager.viewerSlot.startDraft();
      const session = manager.getActiveTab()!.session.runtime;
      manager.getActiveTab()!.controllers.drafts.restore('main', { content: 'new idea' });
      expect(shownLink()).toEqual({ mode: 'auto-draft', path: 'Notes/A.md' });

      // Shown draft: a removed link follows focus again.
      manager.getActiveTab()!.linkedContent.selectExplicit(null);
      focus('Notes/B.md');
      await manager.viewerSlot.startDraft();
      expect([manager.getActiveTab()!.session.runtime === session, shownLink()])
        .toEqual([true, { mode: 'auto-draft', path: 'Notes/B.md' }]);

      // Held draft: an explicit pick is replaced by the Note focused while it was detached.
      manager.getActiveTab()!.linkedContent.selectExplicit('Projects');
      await manager.viewerSlot.show('conversation-1');
      focus('Notes/C.md');
      await manager.viewerSlot.startDraft();
      expect([manager.getActiveTab()!.session.runtime === session, shownLink()])
        .toEqual([true, { mode: 'auto-draft', path: 'Notes/C.md' }]);

      // Held auto draft: it missed focus changes while detached.
      await manager.viewerSlot.show('conversation-1');
      focus('Notes/D.md');
      await manager.viewerSlot.startDraft();
      expect([manager.getActiveTab()!.session.runtime === session, shownLink(), shownDraft(manager)])
        .toEqual([true, { mode: 'auto-draft', path: 'Notes/D.md' }, 'new idea']);
    });

it('starts a fresh new session when the remembered one created its conversation while browsing', async () => {
      const { manager } = await createManager(await conversationPlugin());
      await manager.viewerSlot.startDraft();
      const session = manager.getActiveTab()!.session.runtime;

      await manager.viewerSlot.show('conversation-1');
      session.setConversationId('created');
      await manager.viewerSlot.startDraft();

      expect(manager.getActiveTab()!.session.runtime).not.toBe(session);
      expect(manager.getActiveTab()!.conversationId).toBeNull();
    });

it("returns a blank tab's text after wide browsed another session", async () => {
      const { manager } = await createManager(await conversationPlugin());
      const blank = await manager.createTab(null);
      blank!.controllers.drafts.restore('main', { content: 'new idea' });

      await manager.viewerSlot.enter();
      await manager.viewerSlot.show('conversation-1');
      await manager.viewerSlot.release();
      await manager.switchToTab(blank!.id);

      expect(shownDraft(manager)).toBe('new idea');
    });

it('restores a narrow workspace in wide without assembling its tabs', async () => {
      const { manager } = await createManager(await conversationPlugin(), {}, {}, { showsPreviews: () => true });

      await manager.restoreState({
        openTabs: [{ tabId: 'one', conversationId: 'conversation-1' }, { tabId: 'two', conversationId: 'conversation-2' }],
        activeTabId: 'two',
      });

      const preview = manager.getActiveTab()!;
      expect(manager.getAllTabs()).toEqual([preview]);
      expect(preview).toEqual(expect.objectContaining({ conversationId: 'conversation-2', lifecycleState: 'provisional' }));
      expect(manager.getPersistedState()).toEqual({
        openTabs: [
          { tabId: 'one', conversationId: 'conversation-1' },
          { tabId: 'two', conversationId: 'conversation-2' },
          { tabId: preview.id, conversationId: 'conversation-2', preview: true },
        ],
        activeTabId: preview.id,
      });
    });

it('returns a saved preview to its narrow tab when restoring narrow', async () => {
      const { manager } = await createManager(await conversationPlugin());

      await manager.restoreState({
        openTabs: [
          { tabId: 'one', conversationId: 'conversation-1' },
          { tabId: 'shown', conversationId: 'conversation-1', preview: true },
        ],
        activeTabId: 'shown',
      });

      expect(manager.getTabIdentities().map(tab => tab.id)).toEqual(['one']);
      expect(manager.getActiveTabId()).toBe('one');
    });

it('replaces the preview with a focused Linked content draft', async () => {
      const { plugin } = await linkedContentPlugin(['Projects/Plan.md']);
      const { manager } = await createManager(plugin);
      const retained = await manager.createTab('retained-conversation');
      await manager.viewerSlot.show('conversation-1');
      const preview = manager.getActiveTab()!;

      await manager.viewerSlot.startDraft({ linkedContentPath: 'Projects/Plan.md' });

      const draft = manager.getActiveTab()!;
      expect(manager.getAllTabs()).toEqual([retained, draft]);
      expect(preview.dom.contentEl.isConnected).toBe(false);
      expect(draft.conversationId).toBeNull();
      expect(draft.lifecycleState).toBe('provisional');
      expect(draft.session.runtime.model.linkedContentController.getSnapshot()).toEqual({ mode: 'explicit-draft', path: 'Projects/Plan.md' });
      expect(draft.composer.isFocused()).toBe(true);
    });

it('shows the new draft without passing through the last retained tab', async () => {
      const activations: string[] = [];
      const { manager } = await createManager(await conversationPlugin(), {
        onActiveTabChanged: (_from: string | null, to: string) => { activations.push(to); },
      });
      const retained = await manager.createTab('retained-conversation');
      await manager.viewerSlot.show('conversation-1');
      const preview = manager.getActiveTab()!;
      expect(preview.lifecycleState).toBe('provisional');
      activations.length = 0;

      await manager.viewerSlot.startDraft();

      const draft = manager.getActiveTab()!;
      expect(manager.getAllTabs()).toEqual([retained, draft]);
      expect(draft.lifecycleState).toBe('provisional');
      expect(activations).toEqual([draft.id]);
    });

it('does not create a draft for Linked content that no longer exists', async () => {
      const { plugin } = await linkedContentPlugin([]);
      const { manager } = await createManager(plugin);

      await expect(manager.viewerSlot.startDraft({ linkedContentPath: 'Gone/Plan.md' }))
        .rejects.toThrow('Linked content is no longer available');

      expect(manager.getAllTabs()).toEqual([]);
    });

it('keeps the latest provisional selection during overlapping preview hydration', async () => {
  const { manager, plugin } = await createManager();
  await manager.viewerSlot.show('conversation-1');
  const hydration = holdHistory(plugin, 'conversation-2');
  const first = manager.viewerSlot.show('conversation-2');
  await hydration.started;
  const superseded = manager.viewerSlot.show('conversation-3');
  const latest = manager.viewerSlot.show('conversation-4');
  hydration.release();
  await Promise.all([first, superseded, latest]);
  expect(hydration.read.mock.calls.map(([id]) => id)).toEqual(['conversation-2', 'conversation-4']);
  expect(manager.getActiveTab()).toMatchObject({ conversationId: 'conversation-4', lifecycleState: 'provisional' });
});

it('does not demote a preview retained while its conversation switch is pending', async () => {
  const { manager, plugin } = await createManager();
  await manager.viewerSlot.show('conversation-1');
  const preview = manager.getActiveTab()!;
  const hydration = holdHistory(plugin, 'conversation-2');
  const navigation = manager.viewerSlot.show('conversation-2');
  await hydration.started;
  preview.session.claimUserOwnership();
  preview.session.commitAdmission();
  hydration.release();
  await navigation;
  expect(manager.getActiveTab()?.lifecycleState).toBe('open');
});

it('keeps a stale provisional target retained by the user during initial hydration', async () => {
  const { manager, plugin } = await createManager();
  await manager.createTab();
  const hydration = holdHistory(plugin, 'conversation-1');
  const stale = manager.viewerSlot.show('conversation-1');
  await hydration.started;
  const retained = manager.getActiveTab()!;
  expect(retained.conversationId).toBe('conversation-1');
  const latest = manager.viewerSlot.show('conversation-2');
  retained.session.claimUserOwnership();
  retained.session.commitAdmission();
  hydration.release();
  await Promise.all([stale, latest]);
  expect(manager.getAllTabs()).toContain(retained);
  expect(retained.lifecycleState).toBe('open');
  expect(retained.dom.contentEl.isConnected).toBe(true);
  expect(manager.getActiveTab()?.conversationId).toBe('conversation-2');
});

it('lets an immediate retained-tab selection supersede an in-flight preview', async () => {
  const { manager, plugin } = await createManager();
  const retained = (await manager.createTab('retained'))!;
  await manager.viewerSlot.show('conversation-1');
  const hydration = holdHistory(plugin, 'conversation-2');
  const previewSelection = manager.viewerSlot.show('conversation-2');
  await hydration.started;
  const retainedSelection = manager.openConversation('retained');
  hydration.release();
  await Promise.all([previewSelection, retainedSelection]);
  expect(manager.getActiveTab()).toBe(retained);
});

it('drains and invalidates preview navigation before provisional cleanup', async () => {
  const { manager, plugin } = await createManager();
  await manager.viewerSlot.show('conversation-1');
  const hydration = holdHistory(plugin, 'conversation-2');
  const previewSelection = manager.viewerSlot.show('conversation-2');
  await hydration.started;
  const cleanup = manager.viewerSlot.release();
  const late = manager.viewerSlot.show('conversation-3');
  hydration.release();
  await Promise.all([previewSelection, late, cleanup]);
  expect(manager.getAllTabs().every(tab => tab.lifecycleState !== 'provisional')).toBe(true);
  expect(hydration.read.mock.calls.map(([id]) => id)).toEqual(['conversation-2']);
});

it('prevents queued preview navigation from creating tabs after destroy', async () => {
  const { manager, plugin, root } = await createManager();
  await manager.viewerSlot.show('conversation-1');
  const hydration = holdHistory(plugin, 'conversation-2');
  const first = manager.viewerSlot.show('conversation-2');
  await hydration.started;
  const queued = manager.viewerSlot.show('conversation-3');
  const destruction = manager.destroy();
  hydration.release();
  await Promise.all([first, queued, destruction]);
  expect(manager.getAllTabs()).toEqual([]);
  expect(root.childElementCount).toBe(0);
  expect(hydration.read.mock.calls.map(([id]) => id)).toEqual(['conversation-2']);
});

it('keeps a wide selection out of retained tabs when its owner closes during reveal', async () => {
  const { manager, plugin } = await createManager();
  const retained = (await manager.createTab('retained'))!;
  const target = (await manager.createTab('conversation-1', undefined, { activate: false }))!;
  const revealing = deferred<void>();
  const revealed = deferred<void>();
  vi.spyOn(plugin.app.workspace, 'revealLeaf').mockImplementationOnce(() => { revealing.resolve(); return revealed.promise; });
  const opening = manager.viewerSlot.show('conversation-1');
  await revealing.promise;
  await manager.closeTab(target.id);
  revealed.resolve();
  await opening;
  expect(retained.conversationId).toBe('retained');
  expect(manager.getTab(retained.id)).toBe(retained);
  expect(manager.getActiveTab()).toMatchObject({ conversationId: 'conversation-1', lifecycleState: 'provisional' });
});

it('creates a fresh provisional target when a reused preview closes during switching', async () => {
  const { manager, plugin } = await createManager();
  const source = (await manager.createTab())!;
  await manager.viewerSlot.show('conversation-1');
  const preview = manager.getActiveTab()!;
  const hydration = holdHistory(plugin, 'conversation-2');
  const navigation = manager.viewerSlot.show('conversation-2');
  await hydration.started;
  await manager.closeTab(preview.id);
  hydration.release();
  await navigation;
  expect(manager.getAllTabs()).toEqual(expect.arrayContaining([source, expect.objectContaining({ conversationId: 'conversation-2', lifecycleState: 'provisional' })]));
  expect(preview.dom.contentEl.isConnected).toBe(false);
});

it('seeds the draft its request created even when another tab becomes active before rebind commits', async () => {
  const { manager } = await createManager();
  const bound = (await manager.createTab('conversation-1'))!;
  const other = (await manager.createTab(null, undefined, { activate: false }))!;
  const starting = manager.createNewConversation({ projectId: 'project-1' });
  const switching = manager.switchToTab(other.id);
  await Promise.all([starting, switching]);
  const draft = manager.getTab(bound.id)!;
  expect([draft.conversationId, draft.controllers.conversationController.project.projectId]).toEqual([null, 'project-1']);
  expect(manager.getActiveTab()?.controllers.conversationController.project.projectId).toBeUndefined();
});

it('reattaches a remembered project draft without reseeding its frozen first-turn choice', async () => {
  const { manager } = await createManager();
  await manager.createTab();
  await manager.viewerSlot.enter();
  await manager.viewerSlot.startDraft({ projectId: 'project-1' });
  const session = manager.getActiveTab()!.session.runtime;
  expect(session.model.conversationController.freezeDraftProject()).toBe('project-1');
  await manager.viewerSlot.show('conversation-1');
  await manager.viewerSlot.startDraft({ projectId: 'project-1' });
  expect(manager.getActiveTab()!.session.runtime).toBe(session);
  expect(session.model.conversationController.project).toMatchObject({ projectId: 'project-1', changeable: false });
  session.model.conversationController.releaseDraftProject();
});

it('leaves a usable presentation when narrowing supersedes an unloading wide entry', async () => {
  const { manager } = await createManager();
  const narrow = (await manager.createTab('conversation-1'))!;
  const unloading = deferred<void>();
  const remove = narrow.dom.contentEl.remove.bind(narrow.dom.contentEl);
  vi.spyOn(narrow.dom.contentEl, 'remove').mockImplementationOnce(() => { unloading.resolve(); remove(); });
  const entering = manager.viewerSlot.enter();
  await unloading.promise;
  const releasing = manager.viewerSlot.release();
  await Promise.all([entering, releasing]);
  expect(manager.getActiveTab()).toMatchObject({ id: narrow.id, conversationId: 'conversation-1', lifecycleState: 'open' });
  expect(manager.getActiveTab()?.dom.contentEl.isConnected).toBe(true);
});

it('closes a draft whose Linked content disappears while it is created', async () => {
  const { files, plugin } = await linkedContentPlugin(['Projects/Plan.md']);
  const { manager, root } = await createManager(plugin);
  const retained = (await manager.createTab())!;
  const create = root.createDiv.bind(root);
  vi.spyOn(root, 'createDiv').mockImplementationOnce((...args) => { files.delete('Projects/Plan.md'); return create(...args); });
  await expect(manager.viewerSlot.startDraft({ linkedContentPath: 'Projects/Plan.md' })).rejects.toThrow('Linked content is no longer available');
  expect(manager.getAllTabs()).toEqual([retained]);
  expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(1);
});

it('cleans up the draft when selecting malformed Linked content fails', async () => {
  const { plugin } = await linkedContentPlugin(['../outside.md']);
  const { manager, root } = await createManager(plugin);
  const retained = (await manager.createTab())!;
  await expect(manager.viewerSlot.startDraft({ linkedContentPath: '../outside.md' })).rejects.toThrow();
  expect(manager.getAllTabs()).toEqual([retained]);
  expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(1);
});
it('starts /new from a wide-layout tab as a slot draft, leaving the source tab as it was', async () => {
      const { manager } = await createManager(await conversationPlugin(), {}, {}, {
        startNew: async (sourceTab) => {
          await manager.viewerSlot.startDraft({ sourceTab });
          return true;
        },
      });
      const source = (await manager.createTab('conversation-1'))!;

      await runNew(source!);

      const draft = manager.getActiveTab()!;
      expect(draft).not.toBe(source);
      expect(draft.conversationId).toBeNull();
      expect(draft.lifecycleState).toBe('provisional');
      expect(source.conversationId).toBe('conversation-1');
    });

it.each([
      ['wide', true],
      ['compact', false],
    ])('starts /new in the source session\'s project, or in none (%s)', async (_layout, wide) => {
      const { manager } = await createManager(await conversationPlugin(), {}, {}, {
        // As the view's policy does: the wide layout starts the draft in its slot with the inherited seed.
        startNew: async (sourceTab, seed) => {
          if (!wide) return false;
          await manager.viewerSlot.startDraft({ sourceTab, ...seed });
          return true;
        },
      });
      const draftProject = () => (manager.getActiveTab()!.controllers.conversationController).project.projectId;
      const source = (await manager.createTab(null))!;
      source.controllers.conversationController.seedDraftProject('project-1');

      await runNew(source!);
      const projectDraft = manager.getActiveTab()!;
      expect([projectDraft.session.runtime === source.session.runtime, draftProject()]).toEqual([false, 'project-1']);

      projectDraft.controllers.conversationController.seedDraftProject(null);
      await runNew(projectDraft);
      expect([manager.getActiveTab()!.session.runtime === projectDraft.session.runtime, draftProject()])
        .toEqual([wide, undefined]);
    });

it('clears the source tab in place for /new in the compact layout', async () => {
      const { manager } = await createManager(await conversationPlugin());
      const source = (await manager.createTab('conversation-1'))!;

      await runNew(source!);

      expect(manager.getAllTabs()).toHaveLength(1);
      expect(manager.getActiveTab()).toEqual(expect.objectContaining({ id: source.id, conversationId: null }));
      expect(source.conversationId).toBe('conversation-1');
    });


async function makeBusy(tab: AssembledTabRuntime, kind: 'turn' | 'background' | 'interaction'): Promise<() => Promise<void>> {
  if (kind === 'turn') {
    const release = deferred<void>();
    const pending = tab.session.turns.run(() => release.promise);
    return async () => { release.resolve(); await pending; };
  }
  if (kind === 'interaction') {
    const abort = new AbortController();
    const pending = tab.session.runtime.model.inlinePrompts.requestApproval('waiting', 'Read', {}, 'Read note', undefined, abort.signal);
    expect(tab.session.runtime.hasPendingInteraction).toBe(true);
    return async () => { abort.abort(); await pending; };
  }
  expect(await tab.session.runtime.model.ensureExecutionInitialized()).toBe(true);
  const native = provider.sessions.at(-1)!;
  let busy = true;
  Object.assign(native, { hasBackgroundWork: () => busy });
  const notify = (sequence: number) => native.emit({ type: 'session_state_changed', scope: { kind: 'session', sessionInstanceId: native.sessionInstanceId, sequence }, snapshot: native.getSnapshot() });
  notify(1);
  expect(tab.executionCoordinator.publishedBackgroundWork).toBe(true);
  return async () => { busy = false; notify(2); await tab.session.runtime.awaitBackgroundWork(); };
}

it.each(['turn', 'background', 'interaction'] as const)('rebinds a preview holding %s without retaining its old presentation', async kind => {
  const { manager } = await createManager();
  await manager.viewerSlot.show('conversation-1');
  const preview = manager.getActiveTab()!;
  const release = await makeBusy(preview, kind);
  try {
    await manager.viewerSlot.show('conversation-2');
    expect(manager.getAllTabs()).not.toContain(preview);
    expect(preview.conversationId).toBe('conversation-1');
    expect(preview.dom.contentEl.isConnected).toBe(false);
    expect(manager.getAllTabs()).toEqual([expect.objectContaining({ id: preview.id, conversationId: 'conversation-2', lifecycleState: 'provisional' })]);
    expect(manager.getActiveTabId()).toBe(preview.id);
    expect(preview.session.runtime.isDisposed).toBe(false);
  } finally { await release(); }
});

it.each(['turn', 'background', 'interaction'] as const)('detaches a preview holding %s when leaving wide', async kind => {
  const { manager } = await createManager();
  const retained = (await manager.createTab('conversation-1'))!;
  await manager.viewerSlot.show('conversation-2');
  const preview = manager.getActiveTab()!;
  const release = await makeBusy(preview, kind);
  try {
    await manager.viewerSlot.show('conversation-1');
    await manager.viewerSlot.release();
    expect(manager.getAllTabs()).toEqual([retained]);
    expect(preview.dom.contentEl.isConnected).toBe(false);
    expect(preview.session.runtime.isDisposed).toBe(false);
  } finally { await release(); }
});
