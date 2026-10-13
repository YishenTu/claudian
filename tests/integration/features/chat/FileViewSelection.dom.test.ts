/** @jest-environment jsdom */
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { type App, FileView, ItemView, TextFileView, type TFile, type WorkspaceLeaf } from 'obsidian';

import { appendEditorContext } from '@/core/prompt/editorContext';
import { ComposerContextTray } from '@/features/chat/composer/ComposerContextTray';
import { ComposerSelections } from '@/features/chat/input/ComposerSelections';
import { SelectionController } from '@/features/chat/input/SelectionController';

// Obsidian supplies these DOM helpers; keep the tray and browser selection real.
Object.assign(HTMLElement.prototype, {
  addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
  removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
  toggleClass(this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); },
  empty(this: HTMLElement) { this.replaceChildren(); },
});

const NO_LEAF = null as unknown as WorkspaceLeaf;

const SOURCE = '# header\nvalue = "中文"\nprint(value)\nprint(value)\n';

/** A third-party source viewer: its own view type, a line gutter, and token spans holding the source. */
class SourceViewer extends TextFileView {
  code: HTMLElement;
  gutter: HTMLElement;

  constructor(source: string) {
    super(NO_LEAF);
    this.data = source;
    this.file = { path: 'code/A & B.py' } as TFile;
    this.containerEl = document.createElement('div');
    const content = this.containerEl.createDiv();
    this.gutter = content.createDiv({ text: source.split('\n').map((_, i) => String(i + 1)).join('\n') });
    this.code = content.createEl('pre').createEl('code');
    for (const text of source.match(/\w+|\W+/g) ?? []) {
      this.code.createSpan({ text });
    }
  }

  getViewType(): string {
    return 'some-source-viewer';
  }

  getViewData(): string {
    return this.data;
  }

  setViewData(data: string): void {
    this.data = data;
  }

  clear(): void {}
}

/** A non-text file view, such as a PDF text layer. */
class DocumentViewer extends FileView {
  constructor(text: string) {
    super(NO_LEAF);
    this.file = { path: 'docs/paper.pdf' } as TFile;
    this.containerEl = document.createElement('div');
    this.containerEl.createDiv({ text });
  }

  getViewType(): string {
    return 'some-document-viewer';
  }
}

/** A non-file view, such as the chat itself. */
class PanelView extends ItemView {
  getViewType(): string {
    return 'some-panel';
  }

  getDisplayText(): string {
    return 'Panel';
  }
}

function fixture(view: FileView) {
  const sidebar = document.createElement('div');
  const trayEl = sidebar.createDiv();
  const input = sidebar.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  const outside = document.createElement('p');
  outside.textContent = 'unrelated text';
  document.body.append(view.containerEl, sidebar, outside);
  const tray = new ComposerContextTray(trayEl);
  let activeView: unknown = view;
  const workspace = {
    getActiveViewOfType: (type: abstract new (...args: never[]) => unknown) =>
      activeView instanceof type ? activeView : null,
    getMostRecentLeaf: () => null,
  };
  const controller = new SelectionController({ workspace } as unknown as App, tray, input, sidebar);
  const idle = { start() {}, stop() {}, async poll() {}, clear() {}, getContext: () => null };
  const selections = new ComposerSelections({ editor: controller, browser: idle, canvas: idle });
  controller.start();

  function point(root: Node, offset: number): [Node, number] {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent!.length;
      if (offset <= length) return [node, offset];
      offset -= length;
    }
    throw new Error('Offset outside fixture text');
  }
  function select(root: Node, start: number, end: number, reverse = false) {
    const a = point(root, start);
    const b = point(root, end);
    document.getSelection()!.setBaseAndExtent(...(reverse ? b : a), ...(reverse ? a : b));
    controller.poll();
  }
  return {
    input, trayEl, outside, controller, selections, select,
    activate(next: unknown) { activeView = next; },
    dispose() { selections.stop(); tray.destroy(); },
  };
}

let active: ReturnType<typeof fixture> | undefined;
afterEach(() => {
  active?.dispose();
  active = undefined;
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  jest.useRealTimers();
});

it.each([false, true])('attaches a selection from any text file view with its exact source line (reverse=%s)', async reverse => {
  const view = new SourceViewer(SOURCE);
  active = fixture(view);
  const start = SOURCE.lastIndexOf('print(value)');
  active.select(view.code, start, start + 'print(value)'.length, reverse);

  const context = active.selections.capture().editorSelection!;
  expect(appendEditorContext('Explain', context)).toBe(
    'Explain\n\n<editor_selection path="code/A &amp; B.py" lines="4-4">\n<![CDATA[print(value)]]>\n</editor_selection>',
  );
  const remove = within(active.trayEl).getByRole('button', { name: 'Remove 1 line selected' });
  expect((await axe(remove.parentElement!)).violations).toEqual([]);
  fireEvent.click(remove);
  expect(active.selections.capture()).toEqual({});
});

it.each([
  ['the rendered text no longer matches the source', (view: SourceViewer) => { view.data = 'different source'; }],
  ['the selection spans the gutter', () => undefined],
])('attaches the text without a line range when %s', (name, mutate) => {
  const view = new SourceViewer(SOURCE);
  mutate(view);
  active = fixture(view);
  const content = view.containerEl.firstChild!;
  const gutterLength = view.gutter.textContent!.length;
  if (name.includes('gutter')) {
    active.select(content, gutterLength - 1, gutterLength + 8);
  } else {
    active.select(view.code, 9, 14);
  }

  const context = active.selections.capture().editorSelection!;
  expect(context).toEqual({
    mode: 'selection', notePath: 'code/A & B.py', selectedText: expect.any(String), lineCount: expect.any(Number),
  });
  expect(appendEditorContext('Explain', context)).toMatch(/^Explain\n\n<editor_selection path="code\/A &amp; B.py">\n/);
});

it('attaches a selection from a non-text file view without a line range', () => {
  const view = new DocumentViewer('Attention is all you need');
  active = fixture(view);
  active.select(view.containerEl, 0, 'Attention'.length);

  expect(active.selections.capture().editorSelection).toEqual({
    mode: 'selection', notePath: 'docs/paper.pdf', selectedText: 'Attention', lineCount: 1,
  });
});

it('keeps the selection while focus moves into the chat, then clears it on deselection', () => {
  jest.useFakeTimers();
  const view = new SourceViewer(SOURCE);
  active = fixture(view);
  active.select(view.code, SOURCE.indexOf('value ='), SOURCE.indexOf('print(value)'));

  fireEvent.pointerDown(active.input);
  active.input.focus();
  document.getSelection()?.removeAllRanges();
  active.activate(new PanelView(NO_LEAF));
  jest.advanceTimersByTime(2000);
  active.controller.poll();
  expect(active.selections.capture().editorSelection).toMatchObject({ selectedText: 'value = "中文"\n', startLine: 2 });

  active.input.blur();
  active.activate(view);
  active.controller.poll();
  expect(active.selections.capture()).toEqual({});
});

it('ignores selections outside the active file view', () => {
  const view = new SourceViewer(SOURCE);
  active = fixture(view);
  active.select(active.outside, 0, 'unrelated'.length);
  expect(active.selections.capture()).toEqual({});

  active.select(view.code, 9, 14);
  active.activate(new PanelView(NO_LEAF));
  active.controller.poll();
  expect(active.selections.capture()).toEqual({});
});
