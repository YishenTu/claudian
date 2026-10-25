/** @jest-environment jsdom */

import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import { ProjectMemoryPathTakenError, type ProjectRecord } from '@/core/types';
import { createProject, editProject, type ProjectUIHost } from '@/features/chat/projects/projectActions';
import { t } from '@/i18n/i18n';

jest.mock('obsidian', () => ({
  ...jest.requireActual('@test/__mocks__/obsidian'),
  ...jest.requireActual('@test/helpers/ObsidianSettingsDOM'),
}));

const record: ProjectRecord = {
  id: 'project-1', name: 'Launch', instructions: 'Keep the memory current.',
  memoryPath: '.claudian/projects/launch/MEMORY.md', isPinned: false, isArchived: false, createdAt: 1,
};

function host() {
  const projects = {
    create: jest.fn(async ({ name, instructions }: { name: string; instructions: string }) => (
      { ...record, id: 'created', name, instructions }
    )),
    update: jest.fn().mockResolvedValue(undefined),
    readMemory: jest.fn(async () => ({ content: '# Launch\n', revision: 'r0', modifiedAt: null })),
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
  expect(field(dialog, t('chat.projects.editor.memoryPath')).value).toBe('.claudian/projects/project/MEMORY.md');

  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));
  expect(Notice).toHaveBeenCalledWith(t('chat.projects.editor.nameRequired'));
  expect(projectHost.projects.create).not.toHaveBeenCalled();

  const instructions = 'Always cite the spec. '.repeat(2_000);
  fireEvent.input(field(dialog, t('chat.projects.editor.name')), { target: { value: '  Launch  ' } });
  fireEvent.input(field(dialog, t('chat.projects.editor.instructions')), { target: { value: instructions } });
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(projectHost.projects.create).toHaveBeenCalledWith({
    name: 'Launch', instructions, memoryPath: '.claudian/projects/launch/MEMORY.md',
  });
  await waitFor(() => expect(afterCreate).toHaveBeenCalledWith(expect.objectContaining({ id: 'created' })));
});

it('keeps the editor open when saving fails', async () => {
  const projectHost = host();
  projectHost.projects.update.mockRejectedValueOnce(new Error('disk full'));
  editProject(projectHost.ui, record);
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });

  expect(field(dialog, t('chat.projects.editor.name')).value).toBe('Launch');
  expect(field(dialog, t('chat.projects.editor.instructions')).value).toBe('Keep the memory current.');
  fireEvent.keyDown(field(dialog, t('chat.projects.editor.name')), { key: 'Enter' });

  await waitFor(() => expect(Notice).toHaveBeenCalledWith(t('chat.projects.errors.update')));
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(projectHost.projects.update).toHaveBeenCalledWith('project-1', {
    name: 'Launch', instructions: 'Keep the memory current.', memoryPath: '.claudian/projects/launch/MEMORY.md',
  });
});

it('shows the memory path once, with Open beside it, and opens the memory file from the editor', async () => {
  const projectHost = host();
  editProject(projectHost.ui, record);
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });

  const pathField = within(dialog).getByRole('textbox', { name: t('chat.projects.editor.memoryPath') }) as HTMLInputElement;
  expect(pathField.value).toBe(record.memoryPath);
  expect(within(dialog).queryByText(record.memoryPath)).toBeNull();
  const openButton = within(dialog).getByRole('button', { name: t('chat.projects.editor.openMemory') });
  expect(openButton.closest('.setting-item')).toBe(pathField.closest('.setting-item'));
  expect((await axe(dialog)).violations).toEqual([]);
  fireEvent.click(openButton);

  expect(screen.getByRole('dialog', { name: t('chat.projects.memory.title', { name: 'Launch' }) })).toBeTruthy();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  await waitFor(() => expect(projectHost.projects.readMemory).toHaveBeenCalledWith('project-1'));
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
  const path = field(dialog, t('chat.projects.editor.memoryPath'));
  const save = within(dialog).getByRole('button', { name: t('common.save') }) as HTMLButtonElement;

  fireEvent.click(save);
  expect(projectHost.projects.update).toHaveBeenCalledTimes(1);
  expect(name.disabled).toBe(true);
  expect(instructions.disabled).toBe(true);
  expect(path.disabled).toBe(true);
  expect(save.disabled).toBe(true);

  fail();
  await waitFor(() => expect(Notice).toHaveBeenCalledWith(t('chat.projects.errors.update')));
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(name.disabled).toBe(false);
  expect(instructions.disabled).toBe(false);
  expect(path.disabled).toBe(false);
  expect(save.disabled).toBe(false);
});

it('follows the name with the default memory path until the path is edited', async () => {
  const projectHost = host();
  createProject(projectHost.ui);
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleNew') });
  const name = field(dialog, t('chat.projects.editor.name'));
  const path = field(dialog, t('chat.projects.editor.memoryPath'));

  fireEvent.input(name, { target: { value: 'Alpha' } });
  expect(path.value).toBe('.claudian/projects/alpha/MEMORY.md');
  fireEvent.input(name, { target: { value: 'Alpha Beta!' } });
  expect(path.value).toBe('.claudian/projects/alpha-beta/MEMORY.md');
  fireEvent.input(name, { target: { value: '' } });
  expect(path.value).toBe('.claudian/projects/project/MEMORY.md');

  fireEvent.input(path, { target: { value: 'Work/Alpha.md' } });
  fireEvent.input(name, { target: { value: 'Gamma' } });
  expect(path.value).toBe('Work/Alpha.md');
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(projectHost.projects.create).toHaveBeenCalledWith({ name: 'Gamma', instructions: '', memoryPath: 'Work/Alpha.md' });
});

it('offers and saves a portable default memory directory for a reserved project name', async () => {
  const projectHost = host();
  createProject(projectHost.ui);
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleNew') });

  fireEvent.input(field(dialog, t('chat.projects.editor.name')), { target: { value: 'CON' } });
  expect(field(dialog, t('chat.projects.editor.memoryPath')).value)
    .toBe('.claudian/projects/project-con/MEMORY.md');
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(projectHost.projects.create).toHaveBeenCalledWith({
    name: 'CON', instructions: '', memoryPath: '.claudian/projects/project-con/MEMORY.md',
  });
});

it('saves a custom memory path normalized, appending a missing .md extension', async () => {
  const projectHost = host();
  createProject(projectHost.ui);
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleNew') });

  fireEvent.input(field(dialog, t('chat.projects.editor.name')), { target: { value: 'Launch' } });
  fireEvent.input(field(dialog, t('chat.projects.editor.memoryPath')), { target: { value: ' /Work//Plans/Launch ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(projectHost.projects.create).toHaveBeenCalledWith({
    name: 'Launch', instructions: '', memoryPath: 'Work/Plans/Launch.md',
  });
});

it.each(['../outside.md', 'Work/', '', 'C:/Docs/MEMORY.md', 'Work/what?.md'])(
  'blocks saving the invalid memory path %p with a message on the field until it is fixed',
  async (invalid) => {
    const projectHost = host();
    createProject(projectHost.ui);
    const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleNew') });
    const path = field(dialog, t('chat.projects.editor.memoryPath'));
    fireEvent.input(field(dialog, t('chat.projects.editor.name')), { target: { value: 'Launch' } });
    expect(within(dialog).queryByRole('alert')).toBeNull();

    fireEvent.input(path, { target: { value: invalid } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toBe(t('chat.projects.editor.memoryPathInvalid'));
    expect(path.getAttribute('aria-invalid')).toBe('true');
    expect(path.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
    expect(projectHost.projects.create).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect((await axe(dialog)).violations).toEqual([]);

    fireEvent.input(path, { target: { value: 'Launch.md' } });
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(path.getAttribute('aria-invalid')).not.toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(projectHost.projects.create).toHaveBeenCalledWith({ name: 'Launch', instructions: '', memoryPath: 'Launch.md' });
  },
);

it('explains on the field that a file already exists at the new project memory path', async () => {
  const projectHost = host();
  projectHost.projects.create.mockRejectedValueOnce(new ProjectMemoryPathTakenError('Work/MEMORY.md'));
  createProject(projectHost.ui);
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleNew') });
  const path = field(dialog, t('chat.projects.editor.memoryPath'));
  fireEvent.input(field(dialog, t('chat.projects.editor.name')), { target: { value: 'Launch' } });
  fireEvent.input(path, { target: { value: 'Work/MEMORY.md' } });

  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

  const alert = await within(dialog).findByRole('alert');
  expect(alert.textContent).toBe(t('chat.projects.editor.memoryPathTaken', { path: 'Work/MEMORY.md' }));
  expect(path.getAttribute('aria-invalid')).toBe('true');
  expect(path.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
  expect(path.disabled).toBe(false);
  expect(Notice).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect((await axe(dialog)).violations).toEqual([]);

  fireEvent.input(path, { target: { value: 'Work/Launch.md' } });
  expect(within(dialog).queryByRole('alert')).toBeNull();
});

it('prefills the memory path on edit, keeps it when the name changes, and saves a new path as a move', async () => {
  const projectHost = host();
  editProject(projectHost.ui, { ...record, memoryPath: 'launch.md' });
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });
  const path = field(dialog, t('chat.projects.editor.memoryPath'));
  expect(path.value).toBe('launch.md');
  expect((await axe(dialog)).violations).toEqual([]);

  fireEvent.input(field(dialog, t('chat.projects.editor.name')), { target: { value: 'Launch v2' } });
  expect(path.value).toBe('launch.md');
  fireEvent.input(path, { target: { value: 'Work/Launch.md' } });
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(projectHost.projects.update).toHaveBeenCalledWith('project-1', {
    name: 'Launch v2', instructions: 'Keep the memory current.', memoryPath: 'Work/Launch.md',
  });
});

it('explains on the field a move that would replace another file and keeps the editor open', async () => {
  const projectHost = host();
  projectHost.projects.update.mockRejectedValueOnce(new ProjectMemoryPathTakenError('Work/Launch.md'));
  editProject(projectHost.ui, record);
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.editor.titleEdit') });

  fireEvent.input(field(dialog, t('chat.projects.editor.memoryPath')), { target: { value: 'Work/Launch.md' } });
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));

  expect((await within(dialog).findByRole('alert')).textContent)
    .toBe(t('chat.projects.editor.memoryPathTaken', { path: 'Work/Launch.md' }));
  expect(Notice).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBe(dialog);
});
