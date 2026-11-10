import { deserialize, serialize } from 'node:v8';

import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createClaudianView } from '@test/helpers/features/chat/ClaudianViewHarness';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { FakeSideSession } from '@test/helpers/features/chat/SideChatSessionHarness';
import { createObsidianWorkspace } from '@test/helpers/ObsidianWorkspace';
import { modelCatalogCases } from '@test/helpers/providerModelCatalogs';
import { testDate } from '@test/helpers/testClock';
import { waitFor as waitForDOM } from '@testing-library/dom';
import { App, Component } from 'obsidian';

import { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { ClaudianViews } from '@/composition/ClaudianViews';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ClaudianSettings, Conversation } from '@/core/types';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import { destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { TabManager } from '@/features/chat/tabs/TabManager';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import { createChatFocusCommand } from '@/features/chat/workspace/ChatFocusCommand';
import { ZenModeController } from '@/features/chat/zen/ZenModeController';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

/**
 * Real chat views, zen controller and chat hotkeys mounted in a narrow stand-in for
 * Obsidian's desktop workspace. Suites register the providers they exercise and call
 * `installChatWorkspaceHooks()` once at module level.
 */

/** Teardown steps run in reverse after each test; suites may push their own. */
export const cleanups: Array<() => Promise<void> | void> = [];

export function installChatWorkspaceHooks(): void {
  const originalStructuredClone = globalThis.structuredClone;
  beforeEach(() => {
    globalThis.structuredClone = value => deserialize(serialize(value));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    globalThis.structuredClone = originalStructuredClone;
    ProviderWorkspaceRegistry.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
}

// Drive the same DOM assertions and their timeout with virtual time in clock-only cases.
export async function waitFor<T>(callback: () => T | Promise<T>, options?: Parameters<typeof waitForDOM>[1]): Promise<T> {
  if (!vi.isFakeTimers()) return waitForDOM(callback, options);
  let settled = false;
  const result = waitForDOM(callback, options);
  void result.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) await vi.advanceTimersByTimeAsync(50);
  return result;
}

type Split = { collapsed: boolean; containerEl: HTMLElement; collapse: () => void };
type Tabs = { selected: Leaf | null; readonly contents: Map<Leaf, HTMLElement> };
export type Leaf = {
  view: unknown;
  getRoot: () => unknown;
  parent?: Tabs;
  isDeferred?: boolean;
  loadIfDeferred?: () => Promise<void>;
};

/** Narrow stand-in for Obsidian's desktop workspace layout and events. */
function createWorkspace() {
  const containerEl = document.body.createDiv({ cls: 'workspace' });
  const createSplit = (cls: string): Split => {
    const split: Split = { collapsed: false, containerEl: containerEl.createDiv({ cls }), collapse: () => setCollapsed(split, true) };
    return split;
  };
  const leftSplit = createSplit('workspace-split mod-left-split');
  const rootEl = containerEl.createDiv({ cls: 'workspace-split mod-vertical mod-root' });
  const rightSplit = createSplit('workspace-split mod-right-split');
  const rootSplit = {};
  const noteEditor = rootEl.createDiv({ cls: 'workspace-leaf' }).createEl('textarea', {
    attr: { 'aria-label': 'Note editor' },
  }) as HTMLTextAreaElement;
  const leaves: Leaf[] = [];
  // Non-chat leaves sharing a sidebar's tab group, such as Outline.
  const otherLeaves: Leaf[] = [];
  const workspace = {
    ...createObsidianWorkspace(containerEl),
    leftSplit,
    rightSplit,
    rootSplit,
    layoutReady: true,
    onLayoutReady: (callback: () => void) => callback(),
    getLeavesOfType: () => leaves,
    iterateAllLeaves: (callback: (leaf: Leaf) => void) => [...leaves, ...otherLeaves].forEach(callback),
    getActiveViewOfType: vi.fn(),
    getActiveFile: () => null,
    revealLeaf: vi.fn(async (leaf: Leaf) => {
      const root = leaf.getRoot() as Split;
      root.collapsed = false;
      if (leaf.parent) leaf.parent.selected = leaf;
      workspace.trigger('resize');
    }),
  };
  const setCollapsed = (split: Split, collapsed: boolean) => {
    split.collapsed = collapsed;
    split.containerEl.hidden = collapsed;
    workspace.trigger('resize');
  };
  return { workspace, rootEl, rootSplit, leftSplit, rightSplit, noteEditor, leaves, otherLeaves, setCollapsed };
}

function createSettings(enabled: boolean): ClaudianSettings {
  const entry = modelCatalogCases.find(candidate => candidate.id === 'claude')!;
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as ClaudianSettings;
  entry.populate(settings);
  settings.enableZenMode = enabled;
  return settings;
}

export async function createChatWorkspaceFixture(options: { enabled?: boolean; ready?: boolean } = {}) {
  const settings = createSettings(options.enabled ?? true);
  ProviderWorkspaceRegistry.setServices('claude', {});
  const { App: HostApp } = await vi.importActual<typeof import('@test/__mocks__/obsidian')>('obsidian');
  const app = new App();
  if (!(app instanceof HostApp)) throw new Error('Expected the shared Obsidian App');
  // Observe scope lifetime; the shared keymap still owns its stack and event routing.
  const scopes: unknown[] = [];
  const pushScope = app.keymap.pushScope.getMockImplementation()!;
  const popScope = app.keymap.popScope.getMockImplementation()!;
  app.keymap.pushScope.mockImplementation(scope => { scopes.push(scope); pushScope(scope); });
  app.keymap.popScope.mockImplementation(scope => {
    const index = scopes.indexOf(scope);
    if (index !== -1) scopes.splice(index, 1);
    popScope(scope);
  });
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  const layout = createWorkspace();
  Object.assign(app, { workspace: layout.workspace, scope: app.keymap.getRootScope() });
  const sessions: FakeSideSession[] = [];
  vi.spyOn(ProviderRegistry, 'createExecutionBackend').mockImplementation((_host, providerId = 'claude') => ({
    providerId,
    createSession: config => {
      const session = new FakeSideSession(config);
      sessions.push(session);
      return session;
    },
  }));
  const conversations: Conversation[] = [];
  const featureFixture = await createFeatureHostFixture({ app, settings: { ...settings, enableAutoTitleGeneration: false }, afterPublish: () => zen.reconcile() });
  const settingsCoordinator = featureFixture.coordinator;
  const zen: ZenModeController = new ZenModeController({
    app,
    isEnabled: (): boolean => settingsCoordinator.getCommittedSettings().enableZenMode,
    getPosition: () => settingsCoordinator.getCommittedSettings().zenModePosition,
    savePosition: (position) => {
      void settingsCoordinator.mutate((draft) => { draft.zenModePosition = position; });
    },
  });
  const find = (id: string) => conversations.find(entry => entry.id === id) ?? null;
  const pool = createSessionRuntimePool(() => plugin);
  const messaging = new SessionMessagingService({ getHost: () => plugin, getActiveConversationId: () => conversations[0]?.id ?? null, refreshModelControls: () => undefined });
  cleanups.push(() => messaging.dispose());
  const plugin = await createChatFeatureHost({
    fixture: featureFixture, sessionRuntimes: pool,
    bindSessionTools: id => messaging.bindSessionTools(id),
    projects: createProjectsFake(),
    chatModelSelection: new ChatModelSelectionCoordinator(settingsCoordinator),
    executionPersistence: {
      registerExecutionBinding: () => undefined,
      releaseExecutionBinding: () => undefined,
      persistExecutionSnapshot: async () => true,
      assertConversationExecutionAuthority: async () => undefined,
      recordConversationActivity: async () => undefined,
    },
    getConversationSummary: find,
    getConversationSync: find,
    getConversationById: async (id: string) => find(id),
    getConversationList: () => conversations.map(conversation => ({ ...conversation, messageCount: conversation.messages.length, preview: '' })),
    updateConversation: async () => undefined,
    renameConversation: async () => undefined,
    registerZenModeSource: (source: Parameters<ZenModeController['register']>[0]) => zen.register(source),
  });

  // Obsidian hides the contents of every unselected tab in a group.
  const createTabs = (): Tabs => {
    let selected: Leaf | null = null;
    const contents = new Map<Leaf, HTMLElement>();
    return {
      contents,
      get selected() { return selected; },
      set selected(leaf) {
        selected = leaf;
        for (const [member, el] of contents) el.hidden = member !== leaf;
      },
    };
  };
  const tabGroups: Record<'left' | 'right' | 'main', Tabs> = {
    left: createTabs(), right: createTabs(), main: createTabs(),
  };
  const addSiblingLeaf = (placement: 'left' | 'right') => {
    const split = placement === 'left' ? layout.leftSplit : layout.rightSplit;
    const leaf: Leaf = { view: {}, getRoot: () => split, parent: tabGroups[placement] };
    layout.otherLeaves.push(leaf);
    return leaf;
  };

  const addView = async (placement: 'left' | 'right' | 'main', ready = true) => {
    const conversation: Conversation = {
      id: `conversation-${conversations.length + 1}`,
      title: 'Zen conversation', createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
      providerId: 'claude',
      selectedModel: modelCatalogCases.find(candidate => candidate.id === 'claude')!.selected,
      messages: [],
      sessionId: `session-${conversations.length + 1}`,
    };
    conversations.push(conversation);
    const split = placement === 'left' ? layout.leftSplit : placement === 'right' ? layout.rightSplit : null;
    const viewContainerEl = (split?.containerEl ?? layout.rootEl).createDiv({ cls: 'claudian-container' });
    const parent = tabGroups[placement];
    const leaf: Leaf = { getRoot: () => split ?? layout.rootSplit, parent, view: null };
    parent.contents.set(leaf, viewContainerEl);
    parent.selected ??= leaf;
    viewContainerEl.hidden = parent.selected !== leaf;
    viewContainerEl.isShown = () => parent.selected === leaf;
    const view = await createClaudianView({
      host: plugin,
      app,
      leaf,
      containerEl: viewContainerEl,
      contentEl: viewContainerEl,
    });
    Object.assign(app, { scope: app.keymap.getRootScope() });
    // The view-owned footer and tab container that onOpen builds.
    view['viewContainerEl'] = viewContainerEl;
    view['buildViewLayout'](viewContainerEl);
    const activeInputSlotEl = viewContainerEl.querySelector<HTMLElement>('.claudian-active-input-slot')!;
    const sideChatChipHostEl = viewContainerEl.querySelector<HTMLElement>('.claudian-side-chat-chip-slot')!;
    const tab: AssembledTabRuntime = await createTabRuntime({
      plugin,
      component: new Component(),
      containerEl: view['tabContentEl']!,
      mentionDataProvider: new VaultMentionDataProvider(plugin.app),
      conversation, getProviderCatalogConfig: () => null, isRuntimeLive: () => true,
    openConversation: async () => {}, startNewConversation: async () => {},
    });
    await tab.session.runtime.model.hydrate();
    // jsdom has no layout engine; model the native visibility query at the browser boundary.
    tab.dom.inputEl.checkVisibility = () => {
      if (!tab.dom.inputEl.isConnected) return false;
      for (let el: HTMLElement | null = tab.dom.inputEl; el; el = el.parentElement) {
        const style = el.ownerDocument.defaultView!.getComputedStyle(el);
        if (el.hidden || style.display === 'none' || style.visibility === 'hidden'
          || style.visibility === 'collapse' || style.opacity === '0') return false;
      }
      return true;
    };
    tab.dom.contentEl.removeClass('claudian-hidden');
    cleanups.push(() => destroyTab(tab));
    view['tabManager'] = Object.assign(new TabManager(plugin, view['tabContentEl']!, view, {},
      new VaultMentionDataProvider(plugin.app)), {
      getActiveTab: () => tab,
      getTab: (id: string) => id === tab.id ? tab : null,
      getTabCount: () => 1,
    });

    Object.assign(view['tabWorkspace'], { lifecycleRevision: 1, initializedRevision: ready ? 1 : -1 });
    leaf.view = view;
    layout.leaves.push(leaf);
    view['presentation'].update();
    view['startZenModeSource']();
    cleanups.push(() => {
      view['stopZenModeSource']();
      view['sessions'].dispose();
    });
    return { view, tab, leaf, activeInputSlotEl, sideChatChipHostEl };
  };

  zen.start();
  cleanups.push(() => zen.dispose());
  const primary = await addView('right', options.ready ?? true);
  const views = new ClaudianViews(app.workspace, () => 'right-sidebar');
  const focusCommand = createChatFocusCommand({
    getComposer: () => views.getInputFocusView(zen.getActiveLeaf())?.getActiveTab()?.composer ?? null,
    getBackgroundChat: () => views.getBackgroundSidebarLeaf(),
    revealChat: (leaf, focus) => views.activateView(leaf, focus),
  });
  return {
    ...layout, ...primary, app, scopes, zen, views, focusCommand, sessions, settingsCoordinator, addView, addSiblingLeaf,
    toggleChat: () => views.toggleView(zen),
  };
}

export function zenPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.claudian-zen');
}
