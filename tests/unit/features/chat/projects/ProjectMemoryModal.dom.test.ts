/** @jest-environment jsdom */

import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import {
  ProjectMemoryConflictError,
  type ProjectMemoryContent,
  type ProjectMemoryOperations,
  type ProjectRecord,
} from '@/core/types';
import { ProjectMemoryModal } from '@/features/chat/projects/ProjectMemoryModal';
import { t } from '@/i18n/i18n';

jest.mock('obsidian', () => ({
  ...jest.requireActual('@test/__mocks__/obsidian'),
  ...jest.requireActual('@test/helpers/ObsidianSettingsDOM'),
}));

const project: ProjectRecord = {
  id: 'project-1', name: 'Launch', instructions: '', memoryPath: '.claudian/projects/launch/MEMORY.md',
  isPinned: false, createdAt: 1,
};

/** An in-memory project memory honoring the revision contract: a stale save throws unless it overwrites. */
class InMemoryProjectMemory implements ProjectMemoryOperations {
  content: string | null;
  private version = 0;

  constructor(content: string | null) {
    this.content = content;
  }

  private snapshot(): ProjectMemoryContent {
    return { content: this.content ?? '', revision: `r${this.version}` };
  }

  /** Another writer, such as an agent, changes the memory file. */
  writeExternally(content: string | null): void {
    this.content = content;
    this.version += 1;
  }

  readMemory = jest.fn(async () => (this.content === null ? { missing: true as const } : this.snapshot()));

  saveMemory = jest.fn(async (_id: string, content: string, expectedRevision: string, options?: { overwrite?: boolean }) => {
    if (!options?.overwrite && (this.content === null || expectedRevision !== `r${this.version}`)) {
      throw new ProjectMemoryConflictError(project.id);
    }
    this.writeExternally(content);
    return this.snapshot();
  });

  recreateMemory = jest.fn(async () => {
    this.writeExternally('# Launch\n');
    return this.snapshot();
  });
}

async function open(memory: InMemoryProjectMemory) {
  new ProjectMemoryModal({} as App, { project, memory }).open();
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.memory.title', { name: 'Launch' }) });
  const controls = within(dialog);
  const textarea = controls.getByRole('textbox', { name: t('chat.projects.memory.content') }) as HTMLTextAreaElement;
  await waitFor(() => expect(memory.readMemory).toHaveBeenCalled());
  return { dialog, controls, textarea };
}

function type(textarea: HTMLTextAreaElement, value: string): void {
  fireEvent.input(textarea, { target: { value } });
}

beforeEach(() => {
  document.body.replaceChildren();
  jest.clearAllMocks();
});

it('shows the read-only path, copies it, and saves edits against the loaded revision', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  const memory = new InMemoryProjectMemory('# Launch\n');
  const { dialog, controls, textarea } = await open(memory);

  await waitFor(() => expect(textarea.value).toBe('# Launch\n'));
  expect(controls.getByText(project.memoryPath).tagName).toBe('CODE');
  for (const button of controls.getAllByRole('button')) expect(button.getAttribute('type')).toBe('button');
  expect((await axe(dialog)).violations).toEqual([]);

  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.memory.copyPath') }));
  expect(writeText).toHaveBeenCalledWith(project.memoryPath);

  type(textarea, '# Launch\n\n## Goal\nShip it\n');
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(memory.content).toBe('# Launch\n\n## Goal\nShip it\n');
});

it('keeps the user text on a concurrent change and overwrites only when asked', async () => {
  const memory = new InMemoryProjectMemory('# Launch\n');
  const { dialog, controls, textarea } = await open(memory);
  await waitFor(() => expect(textarea.value).toBe('# Launch\n'));

  type(textarea, 'My edits');
  memory.writeExternally('Agent edits');
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));

  expect((await controls.findByRole('alert')).textContent).toBe(t('chat.projects.memory.conflict'));
  expect(textarea.value).toBe('My edits');
  expect(memory.content).toBe('Agent edits');
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect((await axe(dialog)).violations).toEqual([]);

  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.memory.overwrite') }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(memory.content).toBe('My edits');
});

it('reloads the current memory file after a conflict, discarding the user text', async () => {
  const memory = new InMemoryProjectMemory('# Launch\n');
  const { controls, textarea } = await open(memory);
  await waitFor(() => expect(textarea.value).toBe('# Launch\n'));

  type(textarea, 'My edits');
  memory.writeExternally('Agent edits');
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));
  await controls.findByRole('alert');

  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.memory.reload') }));
  await waitFor(() => expect(textarea.value).toBe('Agent edits'));
  expect(controls.queryByRole('button', { name: t('chat.projects.memory.overwrite') })).toBeNull();

  type(textarea, 'Agent edits, reviewed');
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(memory.content).toBe('Agent edits, reviewed');
});

it('offers recreating a missing memory file from the template', async () => {
  const memory = new InMemoryProjectMemory(null);
  const { dialog, controls, textarea } = await open(memory);

  expect((await controls.findByRole('alert')).textContent).toBe(t('chat.projects.memory.missing'));
  expect(textarea.disabled).toBe(true);
  expect((controls.getByRole('button', { name: t('common.save') }) as HTMLButtonElement).disabled).toBe(true);
  expect((await axe(dialog)).violations).toEqual([]);

  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.memory.recreate') }));
  await waitFor(() => expect(textarea.value).toBe('# Launch\n'));
  expect(textarea.disabled).toBe(false);
  expect(controls.queryByRole('alert')).toBeNull();
  expect(memory.recreateMemory).toHaveBeenCalledWith(project.id);
  expect(Notice).not.toHaveBeenCalled();
});

it('locks the text while a save is in flight and unlocks it when the save conflicts', async () => {
  const memory = new InMemoryProjectMemory('# Launch\n');
  const { controls, textarea } = await open(memory);
  await waitFor(() => expect(textarea.value).toBe('# Launch\n'));
  const save = controls.getByRole('button', { name: t('common.save') }) as HTMLButtonElement;
  const reload = controls.getByRole('button', { name: t('chat.projects.memory.reload') }) as HTMLButtonElement;

  let settle!: () => void;
  memory.saveMemory.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    settle = () => reject(new ProjectMemoryConflictError(project.id));
  }));
  type(textarea, 'My edits');
  fireEvent.click(save);

  expect(memory.saveMemory).toHaveBeenCalledWith(project.id, 'My edits', 'r0', undefined);
  expect(textarea.disabled).toBe(true);
  expect(save.disabled).toBe(true);
  expect(reload.disabled).toBe(true);

  settle();
  expect((await controls.findByRole('alert')).textContent).toBe(t('chat.projects.memory.conflict'));
  expect(textarea.disabled).toBe(false);
  expect(save.disabled).toBe(false);
  expect(reload.disabled).toBe(false);
  expect(textarea.value).toBe('My edits');
});
