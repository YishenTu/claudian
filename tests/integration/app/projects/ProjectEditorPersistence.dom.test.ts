/** @vitest-environment jsdom */

import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createPopoutDocument } from '@test/helpers/dom/popoutDocument';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { ProjectService } from '@/app/projects/ProjectService';
import { ProjectStore } from '@/app/projects/ProjectStore';
import { editProject } from '@/features/chat/projects/projectActions';
import { t } from '@/i18n/i18n';

let mockModalDocument: Document | undefined;
vi.mock('obsidian', async () => {
  const dom = (await vi.importActual<typeof import('@test/helpers/ObsidianSettingsDOM')>('@test/helpers/ObsidianSettingsDOM'));
  class Modal extends dom.Modal {
    // Adapt only Obsidian's active-window selection. The editor, actions and persistence stay real.
    open() { (mockModalDocument ?? document).body.appendChild(this.modalEl); this.onOpen(); }
  }
  return { ...(await vi.importActual<typeof import('@test/__mocks__/obsidian')>('@test/__mocks__/obsidian')), ...dom, Modal };
});

afterEach(() => { mockModalDocument = undefined; document.body.replaceChildren(); });

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
    mockModalDocument = popout;
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
