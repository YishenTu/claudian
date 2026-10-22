/** @jest-environment jsdom */

import type { ModalScope } from '@test/helpers/ObsidianSettingsDOM';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { App } from 'obsidian';
import { Component, MarkdownRenderer, Notice } from 'obsidian';

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

const TEMPLATE = '# Launch\n\n## Goal\n\n## State\n';
const FILLED = '# Launch\n\n## Goal\nShip it\n\n## State\nDrafting\n';

/** An in-memory project memory honoring the revision contract: a stale save throws unless it overwrites. */
class InMemoryProjectMemory implements ProjectMemoryOperations {
  content: string | null;
  modifiedAt = testDate({ minutes: -5 }).getTime();
  private version = 0;

  constructor(content: string | null) {
    this.content = content;
  }

  private snapshot(): ProjectMemoryContent {
    return { content: this.content ?? '', revision: `r${this.version}`, modifiedAt: this.modifiedAt };
  }

  /** Another writer, such as an agent, changes the memory file. */
  writeExternally(content: string | null): void {
    this.content = content;
    this.version += 1;
    this.modifiedAt = Date.now();
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
    this.writeExternally(TEMPLATE);
    return this.snapshot();
  });
}

const render = MarkdownRenderer.render as jest.MockedFunction<typeof MarkdownRenderer.render>;
const title = t('chat.projects.memory.title', { name: 'Launch' });
const edit = t('chat.projects.memory.edit');
const preview = t('chat.projects.memory.preview');
const opened: ProjectMemoryModal[] = [];

async function open(memory: InMemoryProjectMemory) {
  const modal = new ProjectMemoryModal({} as App, { project, memory });
  // Obsidian gives every modal a corner close button.
  modal.modalEl.createDiv({ cls: 'modal-close-button' });
  opened.push(modal);
  modal.open();
  const dialog = screen.getByRole('dialog', { name: title });
  const controls = within(dialog);
  // The editor starts hidden behind the rendered view, so its accessible name is checked once shown.
  const textarea = controls.getByRole('textbox', { hidden: true }) as HTMLTextAreaElement;
  await waitFor(() => expect(memory.readMemory).toHaveBeenCalled());
  const scope = modal.scope as unknown as ModalScope;
  return { modal, dialog, controls, textarea, scope };
}

/** Switches to the editor and types; the editor stays shown. */
function type(dialog: HTMLElement, textarea: HTMLTextAreaElement, value: string): void {
  if (textarea.hidden) fireEvent.click(within(dialog).getByRole('button', { name: edit }));
  fireEvent.input(textarea, { target: { value } });
}

/** The rendered view's text, which the renderer stub writes as `rendered:<source path>:<markdown>`. */
function renderedText(dialog: HTMLElement): string | null {
  const rendered = within(dialog).queryByText(/^rendered:/);
  return rendered && !rendered.closest('[hidden]') ? rendered.textContent : null;
}

function visibleButtons(dialog: HTMLElement): string[] {
  return within(dialog).getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent ?? '');
}

function hasDirtyMark(dialog: HTMLElement): boolean {
  const mark = dialog.querySelector('.claudian-project-memory-dirty') as HTMLElement;
  return !mark.hidden;
}

/** Answers the discard confirmation the modal opened over itself. */
async function answerDiscard(discard: boolean): Promise<void> {
  const confirmDialog = await waitFor(() => {
    const dialogs = screen.getAllByRole('dialog');
    const last = dialogs[dialogs.length - 1];
    expect(within(last).getByText(t('chat.projects.memory.discardConfirm'))).toBeTruthy();
    return last;
  });
  fireEvent.click(within(confirmDialog).getByRole('button', {
    name: discard ? t('chat.projects.memory.discard') : t('common.cancel'),
  }));
}

/** Rendered views whose component has released them. */
let released: string[] = [];

beforeEach(() => {
  document.body.replaceChildren();
  jest.clearAllMocks();
  released = [];
  render.mockImplementation(async (_app, markdown, el, sourcePath, component) => {
    for (const line of markdown.split('\n')) {
      const heading = /^(#{1,6}) (.*)$/.exec(line);
      if (heading) el.createEl(`h${heading[1].length}` as 'h1', { text: heading[2] });
    }
    el.createEl('p', { text: `rendered:${sourcePath}:${markdown}` });
    component.register(() => released.push(markdown));
  });
});

afterEach(() => {
  // Stops each modal's refresh timer.
  for (const modal of opened.splice(0)) modal.onClose();
  jest.useRealTimers();
});

it('opens to read the rendered memory with its path, last update, and only Edit', async () => {
  const memory = new InMemoryProjectMemory(FILLED);
  const { dialog, controls, textarea } = await open(memory);

  await waitFor(() => expect(renderedText(dialog)).toBe(`rendered:${project.memoryPath}:${FILLED}`));
  expect(render.mock.lastCall![4]).toBeInstanceOf(Component);
  expect(textarea.hidden).toBe(true);
  expect(textarea.hasAttribute('aria-label')).toBe(false);
  expect(visibleButtons(dialog)).toEqual([edit]);
  // Obsidian's close button ends the title row, with the panel's icon-button look.
  const close = dialog.querySelector('.modal-close-button')!;
  expect(controls.getByText(title).parentElement!.lastElementChild).toBe(close);
  expect(close.classList.contains('claudian-project-memory-icon-btn')).toBe(true);
  // The mode switch is an icon in the display area it switches, alongside the rendered view and the editor.
  const toggle = controls.getByRole('button', { name: edit });
  expect(toggle.textContent).toBe('');
  expect(toggle.parentElement!.contains(controls.getByText(/^rendered:/))).toBe(true);
  expect(toggle.parentElement!.contains(textarea)).toBe(true);
  const path = controls.getByText(project.memoryPath);
  expect(path.tagName).toBe('CODE');
  expect(path.parentElement!.textContent).toContain(t('chat.projects.memory.updated', {
    time: new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-5, 'minute'),
  }));
  expect(controls.queryByText(t('chat.projects.memory.emptyHint'))).toBeNull();
  expect(hasDirtyMark(dialog)).toBe(false);
  for (const button of controls.getAllByRole('button')) expect(button.getAttribute('type')).toBe('button');
  expect((await axe(dialog)).violations).toEqual([]);
});

it('edits with a dirty mark, previews the edits, and saves from either view and by Mod+S', async () => {
  const memory = new InMemoryProjectMemory(FILLED);
  const { dialog, controls, textarea, scope } = await open(memory);
  await waitFor(() => expect(renderedText(dialog)).not.toBeNull());

  expect(scope.press(['Mod'], 'e')).toBe(true);
  expect(controls.getByRole('textbox', { name: title })).toBe(textarea);
  expect(document.activeElement).toBe(textarea);
  expect(released).toContain(FILLED);
  expect(visibleButtons(dialog)).toEqual([preview, t('common.cancel'), t('common.save')]);
  const save = controls.getByRole('button', { name: t('common.save') }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  expect((await axe(dialog)).violations).toEqual([]);

  type(dialog, textarea, `${FILLED}\nMore\n`);
  expect(hasDirtyMark(dialog)).toBe(true);
  expect(save.disabled).toBe(false);
  fireEvent.click(controls.getByRole('button', { name: preview }));
  await waitFor(() => expect(renderedText(dialog)).toBe(`rendered:${project.memoryPath}:${FILLED}\nMore\n`));
  // Unsaved edits keep Save and Cancel in the reading view.
  expect(visibleButtons(dialog)).toEqual([edit, t('common.cancel'), t('common.save')]);

  scope.press(['Mod'], 's');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(memory.saveMemory).toHaveBeenCalledWith(project.id, `${FILLED}\nMore\n`, 'r0', undefined);
  expect(memory.content).toBe(`${FILLED}\nMore\n`);
  expect(Notice).toHaveBeenCalledWith(t('chat.projects.memory.saved'));
});

it('asks before discarding edits on Cancel or close, and keeps them when declined', async () => {
  const memory = new InMemoryProjectMemory(FILLED);
  const { modal, dialog, controls, textarea } = await open(memory);
  await waitFor(() => expect(textarea.value).toBe(FILLED));

  type(dialog, textarea, 'Draft');
  modal.close();
  await answerDiscard(false);
  expect(screen.getByRole('dialog', { name: title })).toBe(dialog);
  expect(textarea.value).toBe('Draft');

  fireEvent.click(controls.getByRole('button', { name: t('common.cancel') }));
  await answerDiscard(true);
  await waitFor(() => expect(renderedText(dialog)).toBe(`rendered:${project.memoryPath}:${FILLED}`));
  expect(textarea.value).toBe(FILLED);
  expect(hasDirtyMark(dialog)).toBe(false);
  expect(memory.saveMemory).not.toHaveBeenCalled();

  // Nothing unsaved: closing needs no confirmation.
  modal.close();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('follows agent edits on disk while reading, and offers Reload or Keep my edits while editing', async () => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  const memory = new InMemoryProjectMemory(FILLED);
  const { dialog, controls, textarea } = await open(memory);
  await jest.advanceTimersByTimeAsync(0);
  expect(renderedText(dialog)).toBe(`rendered:${project.memoryPath}:${FILLED}`);

  memory.writeExternally(`${FILLED}Agent 1\n`);
  await jest.advanceTimersByTimeAsync(2_000);
  expect(renderedText(dialog)).toBe(`rendered:${project.memoryPath}:${FILLED}Agent 1\n`);
  expect(controls.queryByRole('alert')).toBeNull();

  type(dialog, textarea, 'Mine');
  memory.writeExternally(`${FILLED}Agent 2\n`);
  await jest.advanceTimersByTimeAsync(2_000);
  expect(controls.getByRole('alert').textContent).toBe(t('chat.projects.memory.changedOutside'));
  expect(textarea.value).toBe('Mine');

  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.memory.keepMine') }));
  expect(controls.queryByRole('alert')).toBeNull();
  await jest.advanceTimersByTimeAsync(2_000);
  // The declined version is not offered again.
  expect(controls.queryByRole('alert')).toBeNull();
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));
  await jest.advanceTimersByTimeAsync(0);
  expect(memory.content).toBe('Mine');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('reloads the agent version from the on-disk change notice, discarding the edits', async () => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  const memory = new InMemoryProjectMemory(FILLED);
  const { dialog, controls, textarea } = await open(memory);
  await jest.advanceTimersByTimeAsync(0);

  type(dialog, textarea, 'Mine');
  memory.writeExternally('Agent');
  await jest.advanceTimersByTimeAsync(2_000);
  fireEvent.click(within(controls.getByRole('alert').parentElement!).getByRole('button', {
    name: t('chat.projects.memory.reload'),
  }));
  expect(textarea.value).toBe('Agent');
  expect(hasDirtyMark(dialog)).toBe(false);
  expect(controls.queryByRole('alert')).toBeNull();
});

it('keeps the user text on a conflicting save and overwrites or reloads only when asked', async () => {
  const memory = new InMemoryProjectMemory(FILLED);
  const { dialog, controls, textarea } = await open(memory);
  await waitFor(() => expect(textarea.value).toBe(FILLED));

  type(dialog, textarea, 'My edits');
  memory.writeExternally('Agent edits');
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));

  expect((await controls.findByRole('alert')).textContent).toBe(t('chat.projects.memory.conflict'));
  expect(textarea.value).toBe('My edits');
  expect(memory.content).toBe('Agent edits');
  expect((await axe(dialog)).violations).toEqual([]);

  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.memory.reload') }));
  await waitFor(() => expect(textarea.value).toBe('Agent edits'));
  expect(controls.queryByRole('alert')).toBeNull();

  type(dialog, textarea, 'Second edits');
  memory.writeExternally('Agent again');
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));
  await controls.findByRole('alert');
  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.memory.overwrite') }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(memory.content).toBe('Second edits');
});

it('locks the text while a save is in flight and unlocks it when the save conflicts', async () => {
  const memory = new InMemoryProjectMemory(FILLED);
  const { dialog, controls, textarea } = await open(memory);
  await waitFor(() => expect(textarea.value).toBe(FILLED));

  let settle!: () => void;
  memory.saveMemory.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    settle = () => reject(new ProjectMemoryConflictError(project.id));
  }));
  type(dialog, textarea, 'My edits');
  const save = controls.getByRole('button', { name: t('common.save') }) as HTMLButtonElement;
  fireEvent.click(save);

  expect(memory.saveMemory).toHaveBeenCalledWith(project.id, 'My edits', 'r0', undefined);
  expect(textarea.disabled).toBe(true);
  expect(save.disabled).toBe(true);
  expect((controls.getByRole('button', { name: preview }) as HTMLButtonElement).disabled).toBe(true);

  settle();
  expect((await controls.findByRole('alert')).textContent).toBe(t('chat.projects.memory.conflict'));
  expect(textarea.disabled).toBe(false);
  expect(save.disabled).toBe(false);
  expect(textarea.value).toBe('My edits');
});

it('shows Recreate in place of a missing memory file', async () => {
  const memory = new InMemoryProjectMemory(null);
  const { dialog, controls, textarea } = await open(memory);

  expect((await controls.findByRole('alert')).textContent).toBe(t('chat.projects.memory.missing'));
  expect(renderedText(dialog)).toBeNull();
  expect(textarea.hidden).toBe(true);
  // Nothing to switch between: the display area's mode switch is gone.
  expect(controls.queryByRole('button', { name: edit })).toBeNull();
  expect(visibleButtons(dialog)).toEqual([t('chat.projects.memory.recreate')]);
  expect((await axe(dialog)).violations).toEqual([]);

  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.memory.recreate') }));
  await waitFor(() => expect(renderedText(dialog)).toBe(`rendered:${project.memoryPath}:${TEMPLATE}`));
  expect(controls.queryByRole('alert')).toBeNull();
  expect(memory.recreateMemory).toHaveBeenCalledWith(project.id);
  // The fresh template has only headings.
  expect(controls.getByText(t('chat.projects.memory.emptyHint'))).toBeTruthy();
  expect(Notice).not.toHaveBeenCalled();
});

it('opens the editor at a heading clicked in the rendered memory, skipping headings in code', async () => {
  const markdown = '# Launch\n\n```\n# not a heading\n```\n\n## Goal\nShip it\n\n## State\nDrafting\n';
  const memory = new InMemoryProjectMemory(markdown);
  const { dialog, controls, textarea } = await open(memory);
  await waitFor(() => expect(renderedText(dialog)).not.toBeNull());

  // The renderer stub draws one heading per `#` line, so the fenced one is rendered as a heading too: the
  // modal maps the nth rendered heading to the nth source heading outside fences. Drop the stub's extra one.
  controls.getByRole('heading', { name: 'not a heading' }).remove();
  fireEvent.click(controls.getByRole('heading', { name: 'State' }));
  expect(textarea.hidden).toBe(false);
  expect(document.activeElement).toBe(textarea);
  expect(textarea.selectionStart).toBe(markdown.indexOf('## State'));
});
