/** @jest-environment jsdom */

import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import {
  ProjectDocConflictError,
  type ProjectDocContent,
  type ProjectDocOperations,
  type ProjectRecord,
} from '@/core/types';
import { ProjectDocModal } from '@/features/chat/projects/ProjectDocModal';
import { t } from '@/i18n/i18n';

jest.mock('obsidian', () => ({
  ...jest.requireActual('@test/__mocks__/obsidian'),
  ...jest.requireActual('@test/helpers/ObsidianSettingsDOM'),
}));

const project: ProjectRecord = {
  id: 'project-1', name: 'Launch', instructions: '', docPath: '.claudian/projects/launch-project.md',
  isPinned: false, createdAt: 1,
};

/** An in-memory doc honoring the revision contract: a stale save throws unless it overwrites. */
class MemoryProjectDoc implements ProjectDocOperations {
  content: string | null;
  private version = 0;

  constructor(content: string | null) {
    this.content = content;
  }

  private snapshot(): ProjectDocContent {
    return { content: this.content ?? '', revision: `r${this.version}` };
  }

  /** Another writer, such as an agent, changes the doc. */
  writeExternally(content: string | null): void {
    this.content = content;
    this.version += 1;
  }

  readDoc = jest.fn(async () => (this.content === null ? { missing: true as const } : this.snapshot()));

  saveDoc = jest.fn(async (_id: string, content: string, expectedRevision: string, options?: { overwrite?: boolean }) => {
    if (!options?.overwrite && (this.content === null || expectedRevision !== `r${this.version}`)) {
      throw new ProjectDocConflictError(project.id);
    }
    this.writeExternally(content);
    return this.snapshot();
  });

  recreateDoc = jest.fn(async () => {
    this.writeExternally('# Launch\n');
    return this.snapshot();
  });
}

async function open(doc: MemoryProjectDoc) {
  new ProjectDocModal({} as App, { project, docs: doc }).open();
  const dialog = screen.getByRole('dialog', { name: t('chat.projects.doc.title', { name: 'Launch' }) });
  const controls = within(dialog);
  const textarea = controls.getByRole('textbox', { name: t('chat.projects.doc.content') }) as HTMLTextAreaElement;
  await waitFor(() => expect(doc.readDoc).toHaveBeenCalled());
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
  const doc = new MemoryProjectDoc('# Launch\n');
  const { dialog, controls, textarea } = await open(doc);

  await waitFor(() => expect(textarea.value).toBe('# Launch\n'));
  expect(controls.getByText(project.docPath).tagName).toBe('CODE');
  for (const button of controls.getAllByRole('button')) expect(button.getAttribute('type')).toBe('button');
  expect((await axe(dialog)).violations).toEqual([]);

  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.doc.copyPath') }));
  expect(writeText).toHaveBeenCalledWith(project.docPath);

  type(textarea, '# Launch\n\n## Goal\nShip it\n');
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(doc.content).toBe('# Launch\n\n## Goal\nShip it\n');
});

it('keeps the user text on a concurrent change and overwrites only when asked', async () => {
  const doc = new MemoryProjectDoc('# Launch\n');
  const { dialog, controls, textarea } = await open(doc);
  await waitFor(() => expect(textarea.value).toBe('# Launch\n'));

  type(textarea, 'My edits');
  doc.writeExternally('Agent edits');
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));

  expect((await controls.findByRole('alert')).textContent).toBe(t('chat.projects.doc.conflict'));
  expect(textarea.value).toBe('My edits');
  expect(doc.content).toBe('Agent edits');
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect((await axe(dialog)).violations).toEqual([]);

  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.doc.overwrite') }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(doc.content).toBe('My edits');
});

it('reloads the current doc after a conflict, discarding the user text', async () => {
  const doc = new MemoryProjectDoc('# Launch\n');
  const { controls, textarea } = await open(doc);
  await waitFor(() => expect(textarea.value).toBe('# Launch\n'));

  type(textarea, 'My edits');
  doc.writeExternally('Agent edits');
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));
  await controls.findByRole('alert');

  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.doc.reload') }));
  await waitFor(() => expect(textarea.value).toBe('Agent edits'));
  expect(controls.queryByRole('button', { name: t('chat.projects.doc.overwrite') })).toBeNull();

  type(textarea, 'Agent edits, reviewed');
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(doc.content).toBe('Agent edits, reviewed');
});

it('offers recreating a missing doc from the template', async () => {
  const doc = new MemoryProjectDoc(null);
  const { dialog, controls, textarea } = await open(doc);

  expect((await controls.findByRole('alert')).textContent).toBe(t('chat.projects.doc.missing'));
  expect(textarea.disabled).toBe(true);
  expect((controls.getByRole('button', { name: t('common.save') }) as HTMLButtonElement).disabled).toBe(true);
  expect((await axe(dialog)).violations).toEqual([]);

  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.doc.recreate') }));
  await waitFor(() => expect(textarea.value).toBe('# Launch\n'));
  expect(textarea.disabled).toBe(false);
  expect(controls.queryByRole('alert')).toBeNull();
  expect(doc.recreateDoc).toHaveBeenCalledWith(project.id);
  expect(Notice).not.toHaveBeenCalled();
});

it('locks the text while a save is in flight and unlocks it when the save conflicts', async () => {
  const doc = new MemoryProjectDoc('# Launch\n');
  const { controls, textarea } = await open(doc);
  await waitFor(() => expect(textarea.value).toBe('# Launch\n'));
  const save = controls.getByRole('button', { name: t('common.save') }) as HTMLButtonElement;
  const reload = controls.getByRole('button', { name: t('chat.projects.doc.reload') }) as HTMLButtonElement;

  let settle!: () => void;
  doc.saveDoc.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    settle = () => reject(new ProjectDocConflictError(project.id));
  }));
  type(textarea, 'My edits');
  fireEvent.click(save);

  expect(doc.saveDoc).toHaveBeenCalledWith(project.id, 'My edits', 'r0', undefined);
  expect(textarea.disabled).toBe(true);
  expect(save.disabled).toBe(true);
  expect(reload.disabled).toBe(true);

  settle();
  expect((await controls.findByRole('alert')).textContent).toBe(t('chat.projects.doc.conflict'));
  expect(textarea.disabled).toBe(false);
  expect(save.disabled).toBe(false);
  expect(reload.disabled).toBe(false);
  expect(textarea.value).toBe('My edits');
});
