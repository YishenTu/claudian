/** @vitest-environment jsdom */
import {
  createChatWorkspaceFixture,
  installChatWorkspaceHooks,
  waitFor,
  zenPanel,
} from '@test/helpers/features/chat/ChatWorkspaceFixture';
import { screen, within } from '@testing-library/dom';

import { registerProviderModules } from '@/core/providers/registerProviderModules';
import { claudeProviderRegistration } from '@/providers/claude/registration';

registerProviderModules([claudeProviderRegistration]);
installChatWorkspaceHooks();

it.each([true, false])('toggles the normal sidebar composer with zen enabled=%s', async (enabled) => {
  const { focusCommand: command, tab, noteEditor, rightSplit, sessions } = await createChatWorkspaceFixture({ enabled });
  noteEditor.value = 'Selected note text';
  noteEditor.focus();
  noteEditor.setSelectionRange(2, 7);
  tab.dom.inputEl.value = 'Sidebar draft';

  expect(command.checkCallback!(true)).toBe(true);
  expect(document.activeElement).toBe(noteEditor);
  expect(command.checkCallback!(false)).toBe(true);
  const input = within(tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' });
  expect(document.activeElement).toBe(input);
  command.checkCallback!(false);
  expect(document.activeElement).toBe(noteEditor);
  expect([noteEditor.selectionStart, noteEditor.selectionEnd]).toEqual([2, 7]);
  expect(tab.dom.inputEl.value).toBe('Sidebar draft');
  expect(rightSplit.collapsed).toBe(false);
  expect(sessions).toHaveLength(0);
});

it('focuses the selected normal chat view and keeps its return target independent from a presented zen chat', async () => {
  const { focusCommand, addView, workspace, tab, noteEditor, rightSplit, setCollapsed } = await createChatWorkspaceFixture();
  const central = await addView('main');
  workspace.getActiveViewOfType.mockReturnValue(central.view);
  noteEditor.focus();
  focusCommand.checkCallback!(false);
  const centralInput = within(central.tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' });
  expect(document.activeElement).toBe(centralInput);

  setCollapsed(rightSplit, true);
  focusCommand.checkCallback!(false);
  expect(document.activeElement).toBe(noteEditor);
  focusCommand.checkCallback!(false);
  const zenInput = within(tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' });
  expect(document.activeElement).toBe(zenInput);
  focusCommand.checkCallback!(false);
  expect(document.activeElement).toBe(noteEditor);
});

it('leaves focus alone when there is no existing composer or its sidebar is collapsed without zen', async () => {
  const { focusCommand, noteEditor, rightSplit, setCollapsed, leaves, view } = await createChatWorkspaceFixture({ enabled: false });
  noteEditor.focus();
  setCollapsed(rightSplit, true);
  expect(focusCommand.checkCallback!(true)).toBe(false);
  expect(focusCommand.checkCallback!(false)).toBe(false);
  expect(document.activeElement).toBe(noteEditor);
  expect(rightSplit.collapsed).toBe(true);
  setCollapsed(rightSplit, false);
  expect(focusCommand.checkCallback!(true)).toBe(true);
  view['tabManager'] = null;
  expect(focusCommand.checkCallback!(true)).toBe(false);
  leaves.splice(0);
  expect(focusCommand.checkCallback!(false)).toBe(false);
  expect(document.activeElement).toBe(noteEditor);
});

it.each([true, false])('brings a sidebar chat behind a sibling tab to the front and toggles focus with the note with zen enabled=%s', async (enabled) => {
  const { focusCommand, addSiblingLeaf, leaf, tab, noteEditor, rightSplit } = await createChatWorkspaceFixture({ enabled });
  const backlinks = addSiblingLeaf('right');
  leaf.parent!.selected = backlinks;
  noteEditor.focus();

  expect(focusCommand.checkCallback!(true)).toBe(true);
  expect(leaf.parent!.selected).toBe(backlinks);
  expect(focusCommand.checkCallback!(false)).toBe(true);

  // The command reveals asynchronously and exposes no completion signal.
  await waitFor(() => expect(document.activeElement)
    .toBe(within(tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' })));
  expect(leaf.parent!.selected).toBe(leaf);
  expect(rightSplit.collapsed).toBe(false);
  expect(zenPanel()).toBeNull();
  expect(focusCommand.checkCallback!(false)).toBe(true);
  expect(document.activeElement).toBe(noteEditor);
  expect(leaf.parent!.selected).toBe(leaf);
});

it.each(['display', 'visibility', 'opacity', 'detached'])('skips a composer hidden by %s and rejects the command if none remain visible', async (reason) => {
  const { focusCommand, addView, view, noteEditor, leftSplit, setCollapsed } = await createChatWorkspaceFixture({ enabled: false });
  const other = await addView('left');
  noteEditor.focus();
  expect(focusCommand.checkCallback!(true)).toBe(true);
  if (reason === 'display') view['viewContainerEl']!.style.display = 'none';
  else if (reason === 'visibility') view['viewContainerEl']!.style.visibility = 'hidden';
  else if (reason === 'opacity') view['viewContainerEl']!.style.opacity = '0';
  else view['viewContainerEl']!.remove();

  expect(focusCommand.checkCallback!(false)).toBe(true);
  expect(document.activeElement).toBe(within(other.tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' }));
  focusCommand.checkCallback!(false);
  expect(document.activeElement).toBe(noteEditor);
  setCollapsed(leftSplit, true);
  expect(focusCommand.checkCallback!(true)).toBe(false);
  expect(focusCommand.checkCallback!(false)).toBe(false);
  expect(document.activeElement).toBe(noteEditor);
});

it('toggles focus between the attached zen composer and the previous control without changing drafts or execution', async () => {
  const { focusCommand: command, tab, sessions, rightSplit, setCollapsed, noteEditor, scopes, settingsCoordinator } = await createChatWorkspaceFixture();
  noteEditor.value = 'A note selection';
  noteEditor.focus();
  noteEditor.setSelectionRange(2, 6);
  expect(command.checkCallback!(true)).toBe(true);
  expect(document.activeElement).toBe(noteEditor);

  setCollapsed(rightSplit, true);
  tab.dom.inputEl.value = 'Unsent draft';
  expect(command.checkCallback!(true)).toBe(true);
  expect(document.activeElement).toBe(noteEditor);
  expect(command.checkCallback!(false)).toBe(true);
  const input = within(screen.getByRole('region', { name: 'Claudian chat' })).getByRole('textbox', { name: 'Message' });
  expect(document.activeElement).toBe(input);
  expect(scopes).toHaveLength(1);
  expect(tab.dom.inputEl.value).toBe('Unsent draft');
  expect(rightSplit.collapsed).toBe(true);
  expect(sessions).toHaveLength(0);

  expect(command.checkCallback!(true)).toBe(true);
  expect(document.activeElement).toBe(input);
  expect(command.checkCallback!(false)).toBe(true);
  expect(document.activeElement).toBe(noteEditor);
  expect([noteEditor.selectionStart, noteEditor.selectionEnd]).toEqual([2, 6]);
  expect(scopes).toHaveLength(0);
  expect(command.checkCallback!(false)).toBe(true);
  expect(document.activeElement).toBe(input);
  expect(tab.dom.inputEl.value).toBe('Unsent draft');

  const otherControl = noteEditor.parentElement!.createEl('button', { text: 'Another control', attr: { type: 'button' } });
  otherControl.focus();
  command.checkCallback!(false);
  expect(document.activeElement).toBe(input);
  command.checkCallback!(false);
  expect(document.activeElement).toBe(otherControl);

  noteEditor.focus();
  await settingsCoordinator.mutate(settings => { settings.enableZenMode = false; });
  expect(command.checkCallback!(false)).toBe(false);
  expect(document.activeElement).toBe(noteEditor);
  expect(scopes).toHaveLength(0);
});

it('ignores removed focus targets and retains the return target across normal and zen presentation changes', async () => {
  const { focusCommand: command, rightSplit, setCollapsed, noteEditor } = await createChatWorkspaceFixture();
  setCollapsed(rightSplit, true);
  noteEditor.focus();
  command.checkCallback!(false);
  const input = within(screen.getByRole('region', { name: 'Claudian chat' })).getByRole('textbox', { name: 'Message' });
  noteEditor.remove();
  command.checkCallback!(false);
  expect(document.activeElement).toBe(input);

  document.body.append(noteEditor);
  noteEditor.focus();
  command.checkCallback!(false);
  setCollapsed(rightSplit, false);
  command.checkCallback!(false);
  expect(document.activeElement).toBe(noteEditor);
  command.checkCallback!(false);
  expect(document.activeElement).toBe(input);
  setCollapsed(rightSplit, true);
  command.checkCallback!(false);
  expect(document.activeElement).toBe(noteEditor);
});
