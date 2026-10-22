/** @jest-environment jsdom */

import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import { ProjectDocMoveConflictError, type ProjectRecord } from '@/core/types';
import { createProject, editProject, type ProjectUIHost } from '@/features/chat/projects/projectActions';
import { t } from '@/i18n/i18n';

jest.mock('obsidian', () => ({
  ...jest.requireActual('@test/__mocks__/obsidian'),
  ...jest.requireActual('@test/helpers/ObsidianSettingsDOM'),
}));

const record: ProjectRecord = {
  id: 'project-1', name: 'Launch', instructions: 'Keep the doc current.',
  docPath: '.claudian/projects/launch-project.md', isPinned: false, createdAt: 1,
};

function host() {
  const projects = {
    create: jest.fn(async ({ name, instructions }: { name: string; instructions: string }) => (
      { ...record, id: 'created', name, instructions }
    )),
    update: jest.fn().mockResolvedValue(undefined),
    readDoc: jest.fn(async () => ({ content: '# Launch\n', revision: 'r0' })),
  };
  return { app: {} as App, projects, ui: { app: {} as App, projects } as unknown as ProjectUIHost };
}

function field(dialog: HTMLElement, name: string): HTMLInputElement {
  return within(dialog).getByRole('textbox', { name }) as HTMLInputElement;
}

beforeEach(() => {
  document.body.replaceChildren();
  jest.clearAllMocks();
});

it('creates a project with long instructions and runs the follow-up once it exists', async () => {
  const projectHost = host();
  const afterCreate = jest.fn().mockResolvedValue(undefined);
  createProject(projectHost.ui, { run: afterCreate, failureMessage: 'move failed' });
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleNew') });
  expect((await axe(dialog)).violations).toEqual([]);
  expect(field(dialog, t('chat.projects.editor.docFolder')).value).toBe('.claudian/projects');

  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));
  expect(Notice).toHaveBeenCalledWith(t('chat.projects.editor.nameRequired'));
  expect(projectHost.projects.create).not.toHaveBeenCalled();

  const instructions = 'Always cite the spec. '.repeat(2_000);
  fireEvent.input(field(dialog, t('chat.projects.editor.name')), { target: { value: '  Launch  ' } });
  fireEvent.input(field(dialog, t('chat.projects.editor.instructions')), { target: { value: instructions } });
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(projectHost.projects.create).toHaveBeenCalledWith({ name: 'Launch', instructions, docFolder: '.claudian/projects' });
  await waitFor(() => expect(afterCreate).toHaveBeenCalledWith(expect.objectContaining({ id: 'created' })));
});

it('keeps the editor open when saving fails', async () => {
  const projectHost = host();
  projectHost.projects.update.mockRejectedValueOnce(new Error('disk full'));
  editProject(projectHost.ui, record);
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });

  expect(field(dialog, t('chat.projects.editor.name')).value).toBe('Launch');
  expect(field(dialog, t('chat.projects.editor.instructions')).value).toBe('Keep the doc current.');
  fireEvent.keyDown(field(dialog, t('chat.projects.editor.name')), { key: 'Enter' });

  await waitFor(() => expect(Notice).toHaveBeenCalledWith(t('chat.projects.errors.update')));
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(projectHost.projects.update).toHaveBeenCalledWith('project-1', {
    name: 'Launch', instructions: 'Keep the doc current.', docFolder: '.claudian/projects',
  });
});

it('shows the doc path and opens the doc from the editor', async () => {
  const projectHost = host();
  editProject(projectHost.ui, record);
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });

  expect(within(dialog).getByText(record.docPath).tagName).toBe('CODE');
  expect((await axe(dialog)).violations).toEqual([]);
  fireEvent.click(within(dialog).getByRole('button', { name: t('chat.projects.editor.openDoc') }));

  expect(screen.getByRole('dialog', { name: t('chat.projects.doc.title', { name: 'Launch' }) })).toBeTruthy();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  await waitFor(() => expect(projectHost.projects.readDoc).toHaveBeenCalledWith('project-1'));
});

it('locks the fields while a save is in flight and unlocks them when it fails', async () => {
  const projectHost = host();
  let fail!: () => void;
  projectHost.projects.update.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    fail = () => reject(new Error('disk full'));
  }));
  editProject(projectHost.ui, record);
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });
  const name = field(dialog, t('chat.projects.editor.name'));
  const instructions = field(dialog, t('chat.projects.editor.instructions'));
  const folder = field(dialog, t('chat.projects.editor.docFolder'));
  const save = within(dialog).getByRole('button', { name: t('common.save') }) as HTMLButtonElement;

  fireEvent.click(save);
  expect(projectHost.projects.update).toHaveBeenCalledTimes(1);
  expect(name.disabled).toBe(true);
  expect(instructions.disabled).toBe(true);
  expect(folder.disabled).toBe(true);
  expect(save.disabled).toBe(true);

  fail();
  await waitFor(() => expect(Notice).toHaveBeenCalledWith(t('chat.projects.errors.update')));
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(name.disabled).toBe(false);
  expect(instructions.disabled).toBe(false);
  expect(folder.disabled).toBe(false);
  expect(save.disabled).toBe(false);
});

it('creates the project doc in the chosen folder, normalized and vault-relative', async () => {
  const projectHost = host();
  createProject(projectHost.ui);
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleNew') });

  fireEvent.input(field(dialog, t('chat.projects.editor.name')), { target: { value: 'Launch' } });
  fireEvent.input(field(dialog, t('chat.projects.editor.docFolder')), { target: { value: ' /Work//Plans/ ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(projectHost.projects.create).toHaveBeenCalledWith({ name: 'Launch', instructions: '', docFolder: 'Work/Plans' });
});

it('blocks saving an invalid doc folder with a message on the field until it is fixed', async () => {
  const projectHost = host();
  createProject(projectHost.ui);
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleNew') });
  const folder = field(dialog, t('chat.projects.editor.docFolder'));
  fireEvent.input(field(dialog, t('chat.projects.editor.name')), { target: { value: 'Launch' } });
  expect(within(dialog).queryByRole('alert')).toBeNull();

  fireEvent.input(folder, { target: { value: '../outside' } });
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

  const alert = within(dialog).getByRole('alert');
  expect(alert.textContent).toBe(t('chat.projects.editor.docFolderInvalid'));
  expect(folder.getAttribute('aria-invalid')).toBe('true');
  expect(folder.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
  expect(projectHost.projects.create).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect((await axe(dialog)).violations).toEqual([]);

  fireEvent.input(folder, { target: { value: '' } });
  expect(within(dialog).queryByRole('alert')).toBeNull();
  expect(folder.getAttribute('aria-invalid')).not.toBe('true');
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(projectHost.projects.create).toHaveBeenCalledWith({ name: 'Launch', instructions: '', docFolder: '' });
});

it('prefills the doc folder from the doc path and saves a changed folder as a move', async () => {
  const projectHost = host();
  editProject(projectHost.ui, { ...record, docPath: 'launch-project.md' });
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });
  const folder = field(dialog, t('chat.projects.editor.docFolder'));
  expect(folder.value).toBe('');
  expect((await axe(dialog)).violations).toEqual([]);

  fireEvent.input(folder, { target: { value: 'Work' } });
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(projectHost.projects.update).toHaveBeenCalledWith('project-1', {
    name: 'Launch', instructions: 'Keep the doc current.', docFolder: 'Work',
  });
});

it('explains a doc move that would replace another file and keeps the editor open', async () => {
  const projectHost = host();
  projectHost.projects.update.mockRejectedValueOnce(new ProjectDocMoveConflictError('project-1', 'Work/launch-project.md'));
  editProject(projectHost.ui, record);
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });

  fireEvent.input(field(dialog, t('chat.projects.editor.docFolder')), { target: { value: 'Work' } });
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

  await waitFor(() => expect(Notice).toHaveBeenCalledWith(
    t('chat.projects.errors.docMoveConflict', { path: 'Work/launch-project.md' }),
  ));
  expect(Notice).not.toHaveBeenCalledWith(t('chat.projects.errors.update'));
  expect(screen.getByRole('dialog')).toBe(dialog);
});
