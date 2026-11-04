/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createPopoutDocument } from '@test/helpers/dom/popoutDocument';
import { setObsidianActiveDocument } from '@test/helpers/ObsidianHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { ProjectService } from '@/app/projects/ProjectService';
import { ProjectStore } from '@/app/projects/ProjectStore';
import { editProject } from '@/features/chat/projects/projectActions';
import { t } from '@/i18n/i18n';

afterEach(() => { setObsidianActiveDocument(); document.body.replaceChildren(); });

it.each([
  { label: 'different instructions', instructions: 'From the second editor', expected: 'From the second editor' },
  { label: 'explicitly cleared instructions', instructions: '', expected: '' },
  { label: 'no changed fields', instructions: undefined, expected: 'From the first editor' },
])('keeps another window’s committed project edits when saving $label', async ({ instructions, expected }) => {
  const vault = await DesktopVault.create();
  const store = new ProjectStore(vault.files);
  const projects = new ProjectService([], { store, memory: vault.files });
  try {
    const original = await projects.create({ name: 'Launch', instructions: 'Original instructions', memoryPath: 'Projects/Original.md' });
    const before = await projects.readMemory(original.id);
    if ('missing' in before) throw new Error('Fixture memory missing');
    await projects.saveMemory(original.id, '# Durable work\nKeep these decisions.\n', before.revision);
    const host = { app: vault.app, projects };
    editProject(host, original);
    const first = within(document.body).getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });
    const popout = createPopoutDocument();
    setObsidianActiveDocument(popout);
    editProject(host, original);
    const second = within(popout.body).getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });
    expect(first.ownerDocument).not.toBe(second.ownerDocument);
    const field = (dialog: HTMLElement, name: string) => within(dialog).getByRole('textbox', { name });
    fireEvent.input(field(first, t('chat.projects.editor.name')), { target: { value: 'Launch revised' } });
    fireEvent.input(field(first, t('chat.projects.editor.memoryPath')), { target: { value: 'Projects/Revised.md' } });
    fireEvent.input(field(first, t('chat.projects.editor.instructions')), { target: { value: 'From the first editor' } });
    fireEvent.click(within(first).getByRole('button', { name: t('common.save') }));
    await waitFor(() => expect(first.isConnected).toBe(false));
    expect(projects.get(original.id)).toMatchObject({ name: 'Launch revised', memoryPath: 'Projects/Revised.md' });
    if (instructions !== undefined) {
      fireEvent.input(field(second, t('chat.projects.editor.instructions')), { target: { value: instructions } });
    }
    fireEvent.click(within(second).getByRole('button', { name: t('common.save') }));
    await waitFor(() => expect(second.isConnected).toBe(false));
    expect({
      project: projects.get(original.id),
      oldMemoryExists: await vault.exists('Projects/Original.md'),
      newMemoryExists: await vault.exists('Projects/Revised.md'),
    }).toMatchObject({
      project: { name: 'Launch revised', instructions: expected, memoryPath: 'Projects/Revised.md' },
      oldMemoryExists: false, newMemoryExists: true,
    });
    expect((await store.load()).records[0]).toMatchObject({ name: 'Launch revised', instructions: expected, memoryPath: 'Projects/Revised.md' });
    expect(await vault.read('Projects/Revised.md')).toBe('# Durable work\nKeep these decisions.\n');
  } finally { await projects.dispose(); await vault.dispose(); }
});

it('picks a project icon from the icon panel by mouse and keyboard, and restores the default folder', async () => {
  const vault = await DesktopVault.create();
  const store = new ProjectStore(vault.files);
  const projects = new ProjectService([], { store, memory: vault.files });
  const host = { app: vault.app, projects };
  const dialog = () => within(document.body).getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });
  const iconButton = (icon: string) => within(dialog()).getByRole('button', { name: t('chat.projects.editor.iconButton', { icon }) });
  const panel = () => within(dialog()).getByRole('dialog', { name: t('chat.projects.editor.iconPicker') });
  const saveAndClose = async () => {
    const open = dialog();
    fireEvent.click(within(open).getByRole('button', { name: t('common.save') }));
    await waitFor(() => expect(open.isConnected).toBe(false));
  };
  try {
    const original = await projects.create({ name: 'Launch', instructions: '', memoryPath: 'Projects/Launch.md' });
    expect(original.icon).toBeUndefined();

    editProject(host, original);
    const defaultLabel = t('chat.projects.editor.iconDefault');
    const trigger = iconButton(defaultLabel);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const search = within(panel()).getByRole('searchbox', { name: t('chat.projects.editor.iconSearch') });
    expect(document.activeElement).toBe(search);
    expect(within(panel()).getByRole('button', { name: defaultLabel }).getAttribute('aria-pressed')).toBe('true');
    expect(within(panel()).getByRole('button', { name: 'rocket' }).getAttribute('aria-pressed')).toBe('false');
    expect(await axe(dialog(), { runOnly: ['label', 'aria-valid-attr-value', 'aria-allowed-attr', 'button-name'] })).toHaveNoViolations();

    // Escape closes only the panel and returns focus to its trigger.
    fireEvent.keyDown(search, { key: 'Escape', keyCode: 27 });
    expect(within(dialog()).queryByRole('dialog', { name: t('chat.projects.editor.iconPicker') })).toBeNull();
    expect(document.activeElement).toBe(iconButton(defaultLabel));

    // Searching narrows the grid; the arrow keys move between icons.
    fireEvent.click(iconButton(defaultLabel));
    fireEvent.input(within(panel()).getByRole('searchbox'), { target: { value: 'RO' } });
    expect(within(panel()).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['rocket', 'rotate-ccw']);
    fireEvent.keyDown(within(panel()).getByRole('searchbox'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(panel()).getByRole('button', { name: 'rocket' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(within(panel()).getByRole('button', { name: 'rotate-ccw' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    fireEvent.click(document.activeElement!);
    expect(within(dialog()).queryByRole('dialog', { name: t('chat.projects.editor.iconPicker') })).toBeNull();
    expect(document.activeElement).toBe(iconButton('rocket'));
    await saveAndClose();
    expect(projects.get(original.id)?.icon).toBe('lucide-rocket');
    expect((await store.load()).records[0]?.icon).toBe('lucide-rocket');

    editProject(host, projects.get(original.id)!);
    fireEvent.click(iconButton('rocket'));
    expect(within(panel()).getByRole('button', { name: 'rocket' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(panel()).getByRole('button', { name: defaultLabel }));
    await saveAndClose();
    expect(projects.get(original.id)?.icon).toBeUndefined();
    expect((await store.load()).records[0]).not.toHaveProperty('icon');
  } finally { await projects.dispose(); await vault.dispose(); }
});

it('picks an icon in a popout window and releases the open icon panel when the editor closes', async () => {
  const vault = await DesktopVault.create();
  const projects = new ProjectService([], { store: new ProjectStore(vault.files), memory: vault.files });
  const host = { app: vault.app, projects };
  const defaultButton = t('chat.projects.editor.iconButton', { icon: t('chat.projects.editor.iconDefault') });
  const panelName = t('chat.projects.editor.iconPicker');
  try {
    const original = await projects.create({ name: 'Launch', instructions: '', memoryPath: 'Projects/Launch.md' });

    // Popout nodes come from another realm; a press inside the panel must not count as outside it.
    const popout = createPopoutDocument();
    setObsidianActiveDocument(popout);
    editProject(host, original);
    const popoutDialog = within(popout.body).getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });
    fireEvent.click(within(popoutDialog).getByRole('button', { name: defaultButton }));
    const rocket = within(within(popoutDialog).getByRole('dialog', { name: panelName })).getByRole('button', { name: 'rocket' });
    fireEvent.pointerDown(rocket);
    // A browser fires no click on a button removed by its own pointerdown.
    expect(rocket.isConnected).toBe(true);
    fireEvent.click(rocket);
    expect(within(popoutDialog).getByRole('button', { name: t('chat.projects.editor.iconButton', { icon: 'rocket' }) })).toBeTruthy();
    // Focus leaving the picker closes its panel.
    fireEvent.click(within(popoutDialog).getByRole('button', { name: t('chat.projects.editor.iconButton', { icon: 'rocket' }) }));
    within(popoutDialog).getByRole('textbox', { name: t('chat.projects.editor.name') }).focus();
    expect(within(popoutDialog).queryByRole('dialog', { name: panelName })).toBeNull();
    fireEvent.click(within(popoutDialog).getByRole('button', { name: t('common.save') }));
    await waitFor(() => expect(popoutDialog.isConnected).toBe(false));
    expect(projects.get(original.id)?.icon).toBe('lucide-rocket');

    // Closing the editor with the panel open leaves no panel key handling behind.
    setObsidianActiveDocument();
    editProject(host, projects.get(original.id)!);
    const dialog = within(document.body).getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });
    fireEvent.click(within(dialog).getByRole('button', { name: t('chat.projects.editor.iconButton', { icon: 'rocket' }) }));
    expect(within(dialog).getByRole('dialog', { name: panelName })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
    expect(dialog.isConnected).toBe(false);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
  } finally { await projects.dispose(); await vault.dispose(); }
});
