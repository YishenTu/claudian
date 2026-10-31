/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import type { ModalScope } from '@test/helpers/ObsidianHost';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { App, Component, MarkdownRenderer, Modal, Notice } from 'obsidian';
import type { MockedFunction } from 'vitest';

import {
  ProjectMemoryConflictError,
  type ProjectMemoryContent,
  type ProjectMemoryOperations,
  type ProjectRecord,
} from '@/core/types';
import { ProjectMemoryModal } from '@/features/chat/projects/ProjectMemoryModal';
import { t } from '@/i18n/i18n';





const project: ProjectRecord = {
  id: 'project-1', name: 'Launch', instructions: '', memoryPath: '.claudian/projects/launch/MEMORY.md',
  isPinned: false, isArchived: false, createdAt: 1,
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

  readMemory = vi.fn(async () => (this.content === null ? { missing: true as const } : this.snapshot()));

  saveMemory = vi.fn(async (_id: string, content: string, expectedRevision: string, options?: { overwrite?: boolean }) => {
    if (!options?.overwrite && (this.content === null || expectedRevision !== `r${this.version}`)) {
      throw new ProjectMemoryConflictError(project.id);
    }
    this.writeExternally(content);
    return this.snapshot();
  });

  recreateMemory = vi.fn(async () => {
    this.writeExternally(TEMPLATE);
    return this.snapshot();
  });
}

const render = MarkdownRenderer.render as MockedFunction<typeof MarkdownRenderer.render>;
const title = t('chat.projects.memory.title', { name: 'Launch' });
const edit = t('chat.projects.memory.edit');
const preview = t('chat.projects.memory.preview');
const opened: ProjectMemoryModal[] = [];

async function open(memory: InMemoryProjectMemory) {
  const app = new App();
  const modal = new ProjectMemoryModal(app, { project, memory });
  // Obsidian gives every modal a corner close button.
  modal.modalEl.createDiv({ cls: 'modal-close-button' });
  opened.push(modal);
  modal.open();
  const dialog = screen.getByRole('dialog', { name: title });
  const controls = within(dialog);
  // The editor starts hidden behind the rendered view, so its accessible name is checked once shown.
  const textarea = controls.getByRole('textbox', { hidden: true }) as HTMLTextAreaElement;
  await waitFor(() => expect(memory.readMemory).toHaveBeenCalled());
  expect(app.keymap.pushScope).toHaveBeenCalledExactlyOnceWith(modal.scope);
  const scope = vi.mocked(app.keymap.pushScope).mock.calls[0][0] as unknown as ModalScope;
  return { app, modal, dialog, controls, textarea, scope };
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
async function answerDiscard(discard: boolean, app: App, parentScope: ModalScope): Promise<void> {
  const confirmDialog = await waitFor(() => {
    const dialogs = screen.getAllByRole('dialog');
    const last = dialogs[dialogs.length - 1];
    expect(within(last).getByText(t('chat.projects.memory.discardConfirm'))).toBeTruthy();
    return last;
  });
  const activeScope = vi.mocked(app.keymap.pushScope).mock.calls.at(-1)![0] as unknown as ModalScope;
  expect(activeScope).not.toBe(parentScope);
  expect(app.keymap.popScope).not.toHaveBeenCalledWith(parentScope);
  // The registered confirmation owns these keys; they must not reach the memory editor below.
  expect(activeScope.press(['Mod'], 'e')).toBe(false);
  expect(activeScope.press(['Mod'], 's')).toBe(false);
  fireEvent.click(within(confirmDialog).getByRole('button', {
    name: discard ? t('chat.projects.memory.discard') : t('common.cancel'),
  }));
  expect(app.keymap.popScope).toHaveBeenLastCalledWith(activeScope);
  expect(app.keymap.popScope).not.toHaveBeenCalledWith(parentScope);
}

/** Rendered views whose component has released them. */
let released: string[] = [];

beforeEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
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
  for (const modal of opened.splice(0)) {
    if (modal.containerEl.isConnected) Modal.prototype.close.call(modal);
  }
  vi.useRealTimers();
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
  const { app, dialog, controls, textarea, scope } = await open(memory);
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

  expect(app.keymap.popScope).not.toHaveBeenCalled();
  expect(scope.press(['Mod'], 's')).toBe(true);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(memory.saveMemory).toHaveBeenCalledWith(project.id, `${FILLED}\nMore\n`, 'r0', undefined);
  expect(memory.content).toBe(`${FILLED}\nMore\n`);
  expect(Notice).toHaveBeenCalledWith(t('chat.projects.memory.saved'));
  expect(app.keymap.popScope).toHaveBeenCalledExactlyOnceWith(scope);
});

it('asks before discarding edits on Cancel or close, and keeps them when declined', async () => {
  const memory = new InMemoryProjectMemory(FILLED);
  const { app, modal, dialog, controls, textarea, scope } = await open(memory);
  await waitFor(() => expect(textarea.value).toBe(FILLED));

  type(dialog, textarea, 'Draft');
  modal.close();
  await answerDiscard(false, app, scope);
  expect(screen.getByRole('dialog', { name: title })).toBe(dialog);
  expect(textarea.value).toBe('Draft');
  expect(memory.saveMemory).not.toHaveBeenCalled();

  fireEvent.click(controls.getByRole('button', { name: t('common.cancel') }));
  await answerDiscard(true, app, scope);
  await waitFor(() => expect(renderedText(dialog)).toBe(`rendered:${project.memoryPath}:${FILLED}`));
  expect(textarea.value).toBe(FILLED);
  expect(hasDirtyMark(dialog)).toBe(false);
  expect(memory.saveMemory).not.toHaveBeenCalled();

  // Nothing unsaved: closing releases the remaining editor scope without another confirmation.
  modal.close();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(app.keymap.pushScope).toHaveBeenCalledTimes(3);
  expect(app.keymap.popScope).toHaveBeenCalledTimes(3);
  expect(app.keymap.popScope).toHaveBeenLastCalledWith(scope);
});

it('follows agent edits on disk while reading, and offers Reload or Keep my edits while editing', async () => {
  vi.useFakeTimers({ toNotFake: ['queueMicrotask', 'nextTick'] });
  const memory = new InMemoryProjectMemory(FILLED);
  const { dialog, controls, textarea } = await open(memory);
  await vi.advanceTimersByTimeAsync(0);
  expect(renderedText(dialog)).toBe(`rendered:${project.memoryPath}:${FILLED}`);

  memory.writeExternally(`${FILLED}Agent 1\n`);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(renderedText(dialog)).toBe(`rendered:${project.memoryPath}:${FILLED}Agent 1\n`);
  expect(controls.queryByRole('alert')).toBeNull();

  type(dialog, textarea, 'Mine');
  memory.writeExternally(`${FILLED}Agent 2\n`);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(controls.getByRole('alert').textContent).toBe(t('chat.projects.memory.changedOutside'));
  expect(textarea.value).toBe('Mine');

  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.memory.keepMine') }));
  expect(controls.queryByRole('alert')).toBeNull();
  await vi.advanceTimersByTimeAsync(2_000);
  // The declined version is not offered again.
  expect(controls.queryByRole('alert')).toBeNull();
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));
  await vi.advanceTimersByTimeAsync(0);
  expect(memory.content).toBe('Mine');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('after Keep my edits, measures unsaved changes against the agent version now on disk', async () => {
  vi.useFakeTimers({ toNotFake: ['queueMicrotask', 'nextTick'] });
  const memory = new InMemoryProjectMemory(FILLED);
  const { dialog, controls, textarea } = await open(memory);
  await vi.advanceTimersByTimeAsync(0);

  type(dialog, textarea, 'Mine');
  memory.writeExternally('Agent');
  await vi.advanceTimersByTimeAsync(2_000);
  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.memory.keepMine') }));

  // Back to the opening text, which no longer matches the file: still unsaved.
  type(dialog, textarea, FILLED);
  expect(hasDirtyMark(dialog)).toBe(true);
  const save = controls.getByRole('button', { name: t('common.save') }) as HTMLButtonElement;
  expect(save.disabled).toBe(false);
  // Matching the file again leaves nothing to save.
  type(dialog, textarea, 'Agent');
  expect(hasDirtyMark(dialog)).toBe(false);
  expect(save.disabled).toBe(true);
});

it('reloads the agent version from the on-disk change notice, discarding the edits', async () => {
  vi.useFakeTimers({ toNotFake: ['queueMicrotask', 'nextTick'] });
  const memory = new InMemoryProjectMemory(FILLED);
  const { dialog, controls, textarea } = await open(memory);
  await vi.advanceTimersByTimeAsync(0);

  type(dialog, textarea, 'Mine');
  memory.writeExternally('Agent');
  await vi.advanceTimersByTimeAsync(2_000);
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

it('keeps unsaved edits when conflict Reload fails, then replaces them after Retry succeeds', async () => {
  const memory = new InMemoryProjectMemory(FILLED);
  const { dialog, controls, textarea } = await open(memory);
  await waitFor(() => expect(textarea.value).toBe(FILLED));
  type(dialog, textarea, 'My unsaved edits');
  memory.writeExternally('Agent edits');
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));
  expect((await controls.findByRole('alert')).textContent).toBe(t('chat.projects.memory.conflict'));
  memory.readMemory.mockRejectedValueOnce(new Error('Temporary read failure'));

  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.memory.reload') }));

  await waitFor(() => expect(controls.getByRole('alert').textContent).toBe(t('chat.projects.memory.loadFailed')));
  expect(textarea.value).toBe('My unsaved edits');
  expect(textarea.disabled).toBe(false);
  expect(hasDirtyMark(dialog)).toBe(true);
  expect(memory.content).toBe('Agent edits');
  expect(memory.saveMemory).toHaveBeenCalledTimes(1);
  expect((await axe(dialog)).violations).toEqual([]);

  fireEvent.click(controls.getByRole('button', { name: t('common.retry') }));

  await waitFor(() => expect(textarea.value).toBe('Agent edits'));
  expect(controls.queryByRole('alert')).toBeNull();
  expect(hasDirtyMark(dialog)).toBe(false);
  expect(memory.saveMemory).toHaveBeenCalledTimes(1);
});

it('locks the editor while Reload after a conflict reads the file, so no new typing is overwritten', async () => {
  const memory = new InMemoryProjectMemory(FILLED);
  const { dialog, controls, textarea } = await open(memory);
  await waitFor(() => expect(textarea.value).toBe(FILLED));
  type(dialog, textarea, 'My edits');
  memory.writeExternally('Agent edits');
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));
  await controls.findByRole('alert');

  const read = memory.readMemory.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  memory.readMemory.mockImplementationOnce(async () => {
    await gate;
    return read();
  });
  fireEvent.click(controls.getByRole('button', { name: t('chat.projects.memory.reload') }));

  expect(textarea.disabled).toBe(true);
  release();
  await waitFor(() => expect(textarea.value).toBe('Agent edits'));
  expect(textarea.disabled).toBe(false);
  expect(hasDirtyMark(dialog)).toBe(false);
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


it.each([
  { markdown: 'Launch\n======\n\nGoal\n----\nShip it\n\n## State\nDrafting\n', expected: '## State', heading: 'State' },
  { markdown: 'Launch\n======\n\nGoal\n----\nShip it\n', expected: 'Goal', heading: 'Goal' },
  { markdown: '> ## Quoted\n> Details\n\n## State\nDrafting\n', expected: '## State', heading: 'State' },
])('finds clicked heading sources across supported Markdown syntax: $heading', async ({ markdown, expected, heading }) => {
  // External Obsidian Markdown rendering supplies the headings; mapping them back to source stays real.
  render.mockImplementation(async (_app, _markdown, el) => {
    if (markdown.startsWith('>')) el.createEl('blockquote').createEl('h2', { text: 'Quoted' });
    else {
      el.createEl('h1', { text: 'Launch' });
      el.createEl('h2', { text: 'Goal' });
    }
    if (markdown.includes('## State')) el.createEl('h2', { text: 'State' });
  });
  const { dialog, controls, textarea } = await open(new InMemoryProjectMemory(markdown));
  const target = await controls.findByRole('heading', { name: heading });
  fireEvent.click(target);
  expect(controls.getByRole('textbox', { name: title })).toBe(textarea);
  expect(document.activeElement).toBe(textarea);
  expect(textarea.selectionStart).toBe(markdown.indexOf(expected));
  expect(textarea.selectionEnd).toBe(textarea.selectionStart);
  expect(await axe(dialog)).toHaveNoViolations();
});

it('preserves source offsets after host frontmatter and skips ambiguous extra rendered headings', async () => {
  const markdown = '---\ntitle: Launch\n---\n\n## State\nDrafting\n';
  render.mockImplementation(async (_app, _markdown, el) => { el.createEl('h2', { text: 'State' }); });
  const { controls, textarea } = await open(new InMemoryProjectMemory(markdown));
  fireEvent.click(await controls.findByRole('heading', { name: 'State' }));
  expect(textarea.hidden).toBe(false);
  expect(textarea.selectionStart).toBe(markdown.indexOf('## State'));
  fireEvent.click(controls.getByRole('button', { name: preview }));
  // A host extension's additional heading makes ordinal source attribution ambiguous.
  const renderedHeading = await controls.findByRole('heading', { name: 'State' });
  renderedHeading.parentElement!.createEl('h2', { text: 'Injected heading' });
  fireEvent.click(controls.getByRole('heading', { name: 'Injected heading' }));
  expect(textarea.hidden).toBe(true);
});

it.each(['edit', 'close'])('releases Markdown embed resources registered after the memory preview is retired by %s', async action => {
  let finish!: () => void;
  let finished!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const completed = new Promise<void>(resolve => { finished = resolve; });
  const cleanup = vi.fn();
  const childCleanup = vi.fn();
  const embedEvent = vi.fn();
  const childEvent = vi.fn();
  const eventName = 'memory-preview-embed-event';
  render.mockImplementationOnce(async (_app, _markdown, element, _sourcePath, component) => {
    element.createEl('p', { text: 'Loading embed' });
    await gate;
    window.addEventListener(eventName, embedEvent);
    component.register(() => {
      window.removeEventListener(eventName, embedEvent);
      cleanup();
    });
    const child = new Component();
    window.addEventListener(eventName, childEvent);
    child.register(() => {
      window.removeEventListener(eventName, childEvent);
      childCleanup();
    });
    component.addChild(child);
    finished();
  });
  const { modal, controls, textarea } = await open(new InMemoryProjectMemory(FILLED));
  await controls.findByText('Loading embed');
  if (action === 'edit') {
    fireEvent.click(controls.getByRole('button', { name: edit }));
  } else {
    modal.close();
  }
  expect(textarea.hidden).toBe(action === 'close');
  expect(textarea.value).toBe(FILLED);
  expect(screen.queryByRole('dialog', { name: title }) !== null).toBe(action === 'edit');
  try {
    finish();
    await completed;
    window.dispatchEvent(new Event(eventName));
    expect(embedEvent).not.toHaveBeenCalled();
    expect(childEvent).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(childCleanup).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener(eventName, embedEvent);
    window.removeEventListener(eventName, childEvent);
  }
});
