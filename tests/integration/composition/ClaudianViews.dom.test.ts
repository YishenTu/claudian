/** @vitest-environment jsdom */
import {
  createChatWorkspaceFixture,
  installChatWorkspaceHooks,
  zenPanel,
} from '@test/helpers/features/chat/ChatWorkspaceFixture';
import { testDate } from '@test/helpers/testClock';
import { within } from '@testing-library/dom';

import { registerProviderModules } from '@/core/providers/registerProviderModules';
import { claudeProviderRegistration } from '@/providers/claude/registration';

registerProviderModules([claudeProviderRegistration]);
installChatWorkspaceHooks();

describe('toggle chat view hotkey', () => {
  it.each(['none', 'mounted', 'deferred'])('swaps chat with a non-chat sibling when the other chat is %s', async (otherChat) => {
    const { toggleChat, addView, addSiblingLeaf, leaf, rightSplit, tab } = await createChatWorkspaceFixture();
    const olderSibling = addSiblingLeaf('right');
    Object.assign(olderSibling, { activeTime: testDate({ minutes: -2 }).getTime() });
    const outline = addSiblingLeaf('right');
    Object.assign(outline, { activeTime: testDate({ minutes: -1 }).getTime() });
    if (otherChat !== 'none') {
      const other = await addView('right');
      Object.assign(other.leaf, { activeTime: testDate().getTime() });
      if (otherChat === 'deferred') Object.assign(other.leaf, { view: {}, isDeferred: true });
    }

    await toggleChat();

    expect(leaf.parent!.selected === outline).toBe(true);
    expect(rightSplit.collapsed).toBe(false);
    expect(zenPanel()).toBeNull();

    await toggleChat();

    expect(leaf.parent!.selected).toBe(leaf);
    expect(document.activeElement).toBe(within(tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' }));
  });

  it('hides and re-shows the zen panel while the sidebar stays collapsed', async () => {
    const { toggleChat, rightSplit, setCollapsed, tab, activeInputSlotEl, workspace, noteEditor } = await createChatWorkspaceFixture();
    tab.dom.inputEl.value = 'Unsent draft';
    setCollapsed(rightSplit, true);
    expect(zenPanel()!.contains(tab.dom.inputComposerEl)).toBe(true);

    await toggleChat();

    expect(zenPanel()).toBeNull();
    expect(rightSplit.collapsed).toBe(true);
    expect(tab.dom.inputComposerEl.parentElement).toBe(activeInputSlotEl);
    workspace.trigger('resize');
    expect(zenPanel()).toBeNull();

    noteEditor.focus();
    expect(document.activeElement).toBe(noteEditor);
    await toggleChat();

    expect(zenPanel()!.contains(tab.dom.inputComposerEl)).toBe(true);
    expect(rightSplit.collapsed).toBe(true);
    expect(tab.dom.inputEl.value).toBe('Unsent draft');
    expect(document.activeElement).toBe(within(tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' }));
    expect(workspace.revealLeaf).not.toHaveBeenCalled();

    // Hiding lasts only until the sidebar reopens.
    await toggleChat();
    setCollapsed(rightSplit, false);
    setCollapsed(rightSplit, true);
    expect(zenPanel()!.contains(tab.dom.inputComposerEl)).toBe(true);
  });

  it.each([false, true])('collapses a chat-only group with another chat=%s, then shows zen', async (anotherChat) => {
    const { toggleChat, addView, rightSplit, workspace, tab, noteEditor } = await createChatWorkspaceFixture();
    if (anotherChat) await addView('right');

    await toggleChat();

    expect(rightSplit.collapsed).toBe(true);
    workspace.trigger('layout-change');
    expect(zenPanel()).toBeNull();

    noteEditor.focus();
    await toggleChat();

    expect(zenPanel()).not.toBeNull();
    expect(rightSplit.collapsed).toBe(true);
    expect(document.activeElement).toBe(within(tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' }));
  });

  it('hides and restores the shown sidebar chat even when a main-area chat comes first', async () => {
    const { toggleChat, addView, addSiblingLeaf, leaves, leaf, rightSplit, workspace, tab } = await createChatWorkspaceFixture();
    const central = await addView('main');
    leaves.unshift(leaves.pop()!);
    const outline = addSiblingLeaf('right');

    await toggleChat();

    expect(leaf.parent!.selected).toBe(outline);
    expect(rightSplit.collapsed).toBe(false);

    await toggleChat();

    expect(leaf.parent!.selected).toBe(leaf);
    expect(document.activeElement).toBe(within(tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' }));
    expect(workspace.revealLeaf).not.toHaveBeenCalledWith(central.leaf);
  });

  it('ends hiding when the hidden chat\'s sidebar reopens while the other stays collapsed', async () => {
    const { toggleChat, addView, leftSplit, rightSplit, setCollapsed, tab } = await createChatWorkspaceFixture();
    const left = await addView('left');
    setCollapsed(leftSplit, true);
    expect(zenPanel()!.contains(left.tab.dom.inputComposerEl)).toBe(true);

    await toggleChat();
    setCollapsed(rightSplit, true);
    expect(zenPanel()).toBeNull();

    setCollapsed(leftSplit, false);
    expect(zenPanel()!.contains(tab.dom.inputComposerEl)).toBe(true);
  });

  it('collapses and restores a lone sidebar chat when zen mode is off and a main-area chat comes first', async () => {
    const { toggleChat, addView, leaves, leaf, rightSplit, workspace } = await createChatWorkspaceFixture({ enabled: false });
    const central = await addView('main');
    leaves.unshift(leaves.pop()!);

    await toggleChat();
    expect(rightSplit.collapsed).toBe(true);

    await toggleChat();

    expect(rightSplit.collapsed).toBe(false);
    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
    expect(workspace.revealLeaf).not.toHaveBeenCalledWith(central.leaf);
  });

  it('reveals a sidebar chat when zen mode is off', async () => {
    const { toggleChat, rightSplit, setCollapsed, workspace, leaf } = await createChatWorkspaceFixture({ enabled: false });
    setCollapsed(rightSplit, true);

    await toggleChat();

    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
    expect(rightSplit.collapsed).toBe(false);
    expect(zenPanel()).toBeNull();
  });
});

it('keeps Open Claudian on the active chat view before applying an explicit destination', async () => {
  const fixture = await createChatWorkspaceFixture();
  const second = await fixture.addView('main');
  fixture.tab.controllers.drafts.restore('main', { content: 'First session draft' });
  second.tab.controllers.drafts.restore('main', { content: 'Second session draft' });
  fixture.workspace.getActiveViewOfType.mockReturnValue(second.view);
  second.tab.composer.focus();
  expect(second.tab.composer.isFocused()).toBe(true);

  await fixture.views.activateView();
  expect(fixture.workspace.revealLeaf.mock.calls.at(-1)?.[0] === second.leaf).toBe(true);
  expect(second.tab.composer.isFocused()).toBe(true);
  expect(fixture.tab.composer.isFocused()).toBe(false);
  expect(second.tab.controllers.drafts.capture('main').content).toBe('Second session draft');
  expect(fixture.tab.controllers.drafts.capture('main').content).toBe('First session draft');
  expect(fixture.sessions).toHaveLength(0);

  await fixture.views.activateView(fixture.view.leaf);
  expect(fixture.workspace.revealLeaf.mock.calls.at(-1)?.[0] === fixture.leaf).toBe(true);
  expect(fixture.tab.composer.isFocused()).toBe(true);
  fixture.workspace.getActiveViewOfType.mockReturnValue(null);
  await fixture.views.activateView();
  expect(fixture.workspace.revealLeaf.mock.calls.at(-1)?.[0] === fixture.leaf).toBe(true);
  fixture.leaves.splice(fixture.leaves.indexOf(second.leaf), 1);
  fixture.workspace.getActiveViewOfType.mockReturnValue(second.view);
  await fixture.views.activateView();
  expect(fixture.workspace.revealLeaf.mock.calls.at(-1)?.[0] === fixture.leaf).toBe(true);
  expect(fixture.sessions).toHaveLength(0);
});

it('retains the first deferred chat leaf fallback when no chat is active', async () => {
  const fixture = await createChatWorkspaceFixture();
  const deferredLeaf = { ...fixture.leaf, view: {}, isDeferred: true };
  fixture.leaves.unshift(deferredLeaf);
  fixture.workspace.getActiveViewOfType.mockReturnValue(null);
  await fixture.views.activateView();
  expect(fixture.workspace.revealLeaf.mock.calls.at(-1)?.[0] === deferredLeaf).toBe(true);
  expect(fixture.views.getView() === fixture.view).toBe(true);
  expect(fixture.sessions).toHaveLength(0);
});
