/** @jest-environment jsdom */
import '@/providers';

import { createHarness, releaseSideChatHarnesses } from '@test/helpers/features/chat/SideChatDOMHarness';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { App, Component } from 'obsidian';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { TabCommandDiscovery } from '@/features/chat/tabs/TabCommandDiscovery';
import { destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { syncComposerDropdownForProvider } from '@/features/chat/tabs/tabProviderUI';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import type { AssembledTabRuntime, TabMembershipView } from '@/features/chat/tabs/types';
import { CodexCommandCatalog } from '@/providers/codex/commands/CodexCommandCatalog';
import type { SkillMetadata } from '@/providers/codex/runtime/codexAppServerTypes';
import type { CodexSkillListProvider } from '@/providers/codex/skills/CodexSkillListingService';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

const originalResizeObserver = globalThis.ResizeObserver;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  ProviderWorkspaceRegistry.clear();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await ProviderWorkspaceRegistry.disposeInitialized();
  globalThis.ResizeObserver = originalResizeObserver;
  await releaseSideChatHarnesses();
});

function skill(name = 'review-notes'): SkillMetadata {
  return { name, description: '', path: `/skills/${name}/SKILL.md`, scope: 'user', enabled: true };
}

async function assemble(path: 'membership' | 'fallback') {
  const harness = createHarness();
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref: () => undefined });
  Object.assign(app.workspace, { getActiveFile: () => null });
  const conversation = {
    id: 'conversation-1', providerId: 'codex', selectedModel: 'gpt-5.4', messages: [],
  } as unknown as Conversation;
  const plugin = {
    ...(harness.plugin as ChatFeatureHost), app,
    getCommittedSettings: () => plugin.settings,
    settings: {
      model: 'gpt-5.4', permissionMode: 'normal', requireCommandOrControlEnterToSend: false,
      keyboardNavigation: { focusInputKey: 'i', scrollUpKey: 'w', scrollDownKey: 's' },
      providerConfigs: { codex: { enabled: true } },
    },
    getActiveEnvironmentVariables: () => '',
    getConversationSummary: () => conversation,
    getConversationSync: () => conversation,
    getConversationById: async () => conversation,
    getConversationList: () => [conversation],
  } as unknown as ChatFeatureHost;
  const listing: jest.Mocked<CodexSkillListProvider> = {
    listSkills: jest.fn().mockResolvedValue([skill()]), invalidate: jest.fn(),
  };
  ProviderWorkspaceRegistry.setServices('codex', { commandCatalog: new CodexCommandCatalog(listing) });
  let live = true;
  const membership: TabMembershipView = {
    isDestroyed: () => !live,
    getActiveTabId: () => tab?.id ?? null,
    getTab: id => live && tab?.id === id ? tab : null,
    getAllTabs: () => live && tab ? [tab] : [],
    getTabIdentities: () => live && tab ? [tab.session] : [],
    isTabAlive: candidate => live && candidate.id === tab?.id && candidate.lifecycleState !== 'closing',
    isTabStateMutable: candidate => live && candidate.id === tab?.id,
    isCloseClaimed: () => false,
  };
  const discovery = new TabCommandDiscovery(plugin, membership);
  const tab: AssembledTabRuntime = await createTabRuntime({
    plugin, conversation, component: new Component(), containerEl: document.body.createDiv(),
    mentionDataProvider: new VaultMentionDataProvider(app),
    getProviderCatalogConfig: context => path === 'membership' ? discovery.getProviderCatalogConfig(context) : null,
    isRuntimeLive: () => live,
  });
  discovery.registerTab(tab.id);
  const setCatalog = jest.spyOn(tab.ui.composerDropdown, 'setProviderCatalog');
  syncComposerDropdownForProvider(tab, plugin);
  const ownedDiscovery = setCatalog.mock.calls.at(-1)![1];
  const send = jest.spyOn(tab.controllers.inputController, 'sendMessage');
  const close = async () => {
    if (!live) return;
    live = false;
    discovery.releaseTab(tab.id);
    await destroyTab(tab);
  };
  cleanups.push(close);
  return { tab, plugin, listing, discovery, ownedDiscovery, send, close };
}

async function type(h: Awaited<ReturnType<typeof assemble>>, value: string): Promise<HTMLElement> {
  const input = h.tab.dom.inputEl;
  input.focus();
  input.selectionStart = 0;
  input.selectionEnd = input.value.length;
  const textbox = within(input).getByRole('textbox', { name: 'Message' });
  fireEvent.paste(textbox, { clipboardData: { getData: () => value, files: [] } });
  // ComposerEditor publishes document edits to runtime input listeners in a microtask.
  await Promise.resolve();
  return textbox;
}

describe.each(['membership', 'fallback'] as const)('%s catalog path', path => {
  it.each(['pointer', 'Enter', 'Tab'])('selects provider compact with %s without submitting', async method => {
    const h = await assemble(path);
    const textbox = await type(h, '/');
    await screen.findByRole('option', { name: /^\/compact\s/ });
    expect(screen.getByRole('option', { name: /^\/clear\s/ })).toBeDefined();
    expect(screen.queryByRole('option', { name: '$review-notes' })).toBeNull();
    await type(h, '/comp');
    const compact = await screen.findByRole('option', { name: /^\/compact\s/ });
    if (method === 'pointer') fireEvent.click(compact);
    else fireEvent.keyDown(textbox, { key: method, code: method });
    expect(h.tab.dom.inputEl.value).toBe('/compact ');
    expect(h.tab.ui.composerDropdown.isVisible()).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
    const chip = await screen.findByRole('img', { name: 'Command: /compact' });
    expect(await axe(chip)).toHaveNoViolations();

    // A subsequent ordinary Enter reaches the same real send binding.
    await type(h, '/clear ');
    fireEvent.keyDown(textbox, { key: 'Enter', code: 'Enter' });
    expect(h.send).toHaveBeenCalledTimes(1);
    await h.send.mock.results[0].value;
    expect(h.tab.dom.inputEl.value).toBe('');
  });

  it('keeps the skill trigger separate and renders the selected skill', async () => {
    const h = await assemble(path);
    await type(h, '$');
    const option = await screen.findByRole('option', { name: '$review-notes' });
    expect(screen.queryByRole('option', { name: /^\/compact\s/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /^\/clear\s/ })).toBeNull();
    expect(await axe(option)).toHaveNoViolations();
    fireEvent.click(option);
    expect(h.tab.dom.inputEl.value).toBe('$review-notes ');
    await screen.findByRole('img', { name: 'Skill: review-notes' });
    expect(h.tab.ui.composerDropdown.isVisible()).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('recovers rejected skill discovery through the visible Retry control', async () => {
    const h = await assemble(path);
    h.listing.listSkills.mockRejectedValue(new Error('skills/list unavailable'));
    await type(h, '/');
    await screen.findByRole('option', { name: /^Retry\s/ });
    expect(screen.getByRole('option', { name: 'Could not load provider commands' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('option', { name: /^\/clear\s/ }));
    expect(h.tab.dom.inputEl.value).toBe('/clear ');
    await type(h, '/');
    await screen.findByRole('option', { name: /^Retry\s/ });
    expect(screen.queryByRole('option', { name: /^\/compact\s/ })).toBeNull();
    h.listing.listSkills.mockResolvedValue([skill()]);
    fireEvent.click(screen.getByRole('option', { name: /^Retry\s/ }));
    fireEvent.click(await screen.findByRole('option', { name: /^\/compact\s/ }));
    expect(h.tab.dom.inputEl.value).toBe('/compact ');
    expect(h.tab.ui.composerDropdown.isVisible()).toBe(false);
    await screen.findByRole('img', { name: 'Command: /compact' });
    expect(screen.queryByRole('option', { name: /^Retry\s/ })).toBeNull();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('keeps the replacement catalog menu after an old abort-ignoring request settles', async () => {
    const h = await assemble(path);
    let resolve!: (skills: SkillMetadata[]) => void;
    const pending = new Promise<SkillMetadata[]>(done => { resolve = done; });
    h.listing.listSkills.mockReturnValueOnce(pending);
    await type(h, '$');
    await waitFor(() => expect(h.listing.listSkills).toHaveBeenCalledTimes(1));
    const oldLoad = h.ownedDiscovery.load();
    ProviderWorkspaceRegistry.setServices('codex', {
      commandCatalog: new CodexCommandCatalog({ listSkills: async () => [skill('fresh-skill')], invalidate() {} }),
    });
    h.discovery.invalidateTab(h.tab.id);
    syncComposerDropdownForProvider(h.tab, h.plugin);
    await screen.findByRole('option', { name: '$fresh-skill' });
    resolve([skill('obsolete-skill')]);
    await pending;
    await oldLoad;
    expect(screen.getByRole('option', { name: '$fresh-skill' })).toBeDefined();
    expect(screen.queryByRole('option', { name: '$obsolete-skill' })).toBeNull();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('does not recreate a popup after tab release and destruction', async () => {
    const h = await assemble(path);
    let resolve!: (skills: SkillMetadata[]) => void;
    const pending = new Promise<SkillMetadata[]>(done => { resolve = done; });
    h.listing.listSkills.mockReturnValueOnce(pending);
    await type(h, '$');
    await waitFor(() => expect(h.listing.listSkills).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('listbox')).toBeDefined();
    const oldLoad = h.ownedDiscovery.load();
    await h.close();
    resolve([skill('late-skill')]);
    await pending;
    await oldLoad;
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(within(h.tab.dom.inputContainerEl).queryByRole('listbox', { hidden: true })).toBeNull();
    expect(screen.queryByRole('option', { name: '$late-skill' })).toBeNull();
    expect(h.send).not.toHaveBeenCalled();
  });
});
