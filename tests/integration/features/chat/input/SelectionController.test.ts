// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { installBrowserHighlights } from '@test/helpers/BrowserHighlights';
import { createObsidianEditor } from '@test/helpers/ObsidianEditor';
import { fireEvent, within } from '@testing-library/dom';
import { App, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';

import { ComposerContextTray } from '@/features/chat/composer/ComposerContextTray';
import { ComposerSelections } from '@/features/chat/input/ComposerSelections';
import { SelectionController } from '@/features/chat/input/SelectionController';
import * as highlighting from '@/shared/components/SelectionHighlight';

/** The selection runs under the tab's shared poll cadence; the other sources stay idle. */
let polling: ComposerSelections | null = null;
function startPolling(source: SelectionController): ComposerSelections {
  const idle = { clear: vi.fn(), getContext: () => null, poll: vi.fn(), start: vi.fn(), stop: vi.fn() };
  polling = new ComposerSelections({ editor: source, browser: idle, canvas: idle });
  polling.start();
  return polling;
}
function stopPolling(): void {
  polling?.stop();
  polling = null;
}

describe('SelectionController', () => {
  let controller: SelectionController;
  let app: App;
  let contextTray: ComposerContextTray;
  let trayEl: HTMLElement;
  let inputEl: HTMLTextAreaElement;
  let focusScopeEl: HTMLElement;
  let editor: ReturnType<typeof createObsidianEditor>;
  let editorView: EditorView;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(highlighting, 'showSelectionHighlight');
    vi.spyOn(highlighting, 'hideSelectionHighlight');
    trayEl = document.body.createDiv();
    contextTray = new ComposerContextTray(trayEl);
    vi.spyOn(contextTray, 'setItems');
    vi.spyOn(contextTray, 'clearItems');
    focusScopeEl = document.body.createDiv();
    inputEl = focusScopeEl.createEl('textarea', { attr: { 'aria-label': 'Message' } });
    editorView = new EditorView({
      parent: document.body.createDiv(),
      state: EditorState.create({ doc: 'selected text', selection: { anchor: 0, head: 13 } }),
    });
    editor = createObsidianEditor(editorView);
    const view = Object.assign(new MarkdownView(new WorkspaceLeaf()), {
      editor, file: Object.assign(new TFile(), { path: 'notes/test.md' }),
    });
    app = new App();
    app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);
    controller = new SelectionController(app, contextTray, inputEl, focusScopeEl);
  });

  afterEach(() => {
    stopPolling();
    controller.dispose();
    contextTray.destroy();
    editorView.destroy();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('captures selection and updates indicator', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(controller.getContext()).toEqual({
      notePath: 'notes/test.md',
      mode: 'selection',
      selectedText: 'selected text',
      lineCount: 1,
      startLine: 1,
    });
    expect(contextTray.setItems).toHaveBeenLastCalledWith('editor-selection', [
      expect.objectContaining({ label: '1 line selected' }),
    ]);
    expect(within(trayEl).getByRole('button', { name: 'Remove 1 line selected' })).toBeDefined();

    controller.showHighlight();
    expect(editorView.dom.querySelector('.claudian-selection-highlight')?.textContent).toBe('selected text');
    expect(highlighting.showSelectionHighlight).toHaveBeenCalledWith(editorView, 0, 13);
  });

  it('clears selection immediately when deselected without input handoff intent', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    editorView.dispatch({ selection: { anchor: 0 } });
    (document.activeElement as HTMLElement)?.blur();
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('editor-selection');
    expect(highlighting.hideSelectionHighlight).toHaveBeenCalledWith(editorView);
  });

  it('clears a sticky selection from the tray remove action', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    fireEvent.click(within(trayEl).getByRole('button', { name: 'Remove 1 line selected' }));

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('editor-selection');
  });

  it('preserves selection when focus moves into the chat sidebar', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    vi.mocked(app.workspace.getActiveViewOfType).mockReturnValue(null);
    const sidebarButton = document.createElement('button');
    focusScopeEl.append(sidebarButton);
    sidebarButton.focus();
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(contextTray.clearItems).not.toHaveBeenCalledWith('editor-selection');
  });

  it('preserves selection when the owning chat view is active in a detached window', () => {
    const owningLeaf = new WorkspaceLeaf();
    app.workspace.getMostRecentLeaf = vi.fn().mockReturnValue(owningLeaf);
    controller = new SelectionController(
      app,
      contextTray,
      inputEl,
      focusScopeEl,
      undefined,
      owningLeaf,
    );
    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    vi.mocked(app.workspace.getActiveViewOfType).mockReturnValue(null);
    (document.activeElement as HTMLElement)?.blur();
    vi.advanceTimersByTime(250);

    expect(app.workspace.getMostRecentLeaf).toHaveBeenCalled();
    expect(controller.hasSelection()).toBe(true);
    expect(contextTray.clearItems).not.toHaveBeenCalledWith('editor-selection');
  });

  it('clears selection when a different chat leaf is active', () => {
    const owningLeaf = new WorkspaceLeaf();
    app.workspace.getMostRecentLeaf = vi.fn().mockReturnValue({});
    controller = new SelectionController(
      app,
      contextTray,
      inputEl,
      focusScopeEl,
      undefined,
      owningLeaf,
    );
    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    vi.mocked(app.workspace.getActiveViewOfType).mockReturnValue(null);
    (document.activeElement as HTMLElement)?.blur();
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('editor-selection');
  });

  it('preserves selection when a relocated composer outside tab content has focus', () => {
    const contentScopeEl = document.body.createDiv();
    const composerScopeEl = document.body.createDiv();
    composerScopeEl.append(inputEl);
    controller = new SelectionController(
      app,
      contextTray,
      inputEl,
      [contentScopeEl, composerScopeEl],
    );

    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    vi.mocked(app.workspace.getActiveViewOfType).mockReturnValue(null);
    inputEl.focus();
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(contextTray.clearItems).not.toHaveBeenCalledWith('editor-selection');
  });

  it('preserves selection when shared footer controls have focus', () => {
    const contentScopeEl = document.body.createDiv();
    const composerScopeEl = document.body.createDiv();
    const footerScopeEl = document.body.createDiv();
    const historyButton = document.createElement('button');
    footerScopeEl.append(historyButton);
    controller = new SelectionController(
      app,
      contextTray,
      inputEl,
      [contentScopeEl, composerScopeEl, footerScopeEl],
    );

    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    vi.mocked(app.workspace.getActiveViewOfType).mockReturnValue(null);
    historyButton.focus();
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(contextTray.clearItems).not.toHaveBeenCalledWith('editor-selection');
  });

  it('shows selection highlight when focus enters shared footer controls', () => {
    const footerScopeEl = document.body.createDiv();
    controller = new SelectionController(
      app,
      contextTray,
      inputEl,
      [focusScopeEl, footerScopeEl],
    );
    startPolling(controller);
    vi.advanceTimersByTime(250);
    vi.mocked(highlighting.showSelectionHighlight).mockClear();

    fireEvent.focusIn(footerScopeEl, { relatedTarget: null });

    expect(highlighting.showSelectionHighlight).toHaveBeenCalledWith(editorView, 0, 13);
  });

  it('does not re-show selection highlight when focus moves inside chat focus scopes', () => {
    const footerScopeEl = document.body.createDiv();
    const footerButton = document.createElement('button');
    footerScopeEl.append(footerButton);
    controller = new SelectionController(
      app,
      contextTray,
      inputEl,
      [focusScopeEl, footerScopeEl],
    );
    startPolling(controller);
    vi.advanceTimersByTime(250);
    vi.mocked(highlighting.showSelectionHighlight).mockClear();

    fireEvent.focusIn(focusScopeEl, { relatedTarget: footerButton });

    expect(highlighting.showSelectionHighlight).not.toHaveBeenCalled();
  });

  it('shows fake highlight when focus moves to another sidebar control in edit mode', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    const sidebarButton = document.createElement('button');
    focusScopeEl.append(sidebarButton);
    sidebarButton.focus();

    controller.showHighlight();

    expect(highlighting.showSelectionHighlight).toHaveBeenCalledWith(editorView, 0, 13);
    expect(highlighting.hideSelectionHighlight).not.toHaveBeenCalled();
  });

  it('clears selection when focus leaves markdown and the chat sidebar is not focused', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);
    expect(controller.hasSelection()).toBe(true);

    vi.mocked(app.workspace.getActiveViewOfType).mockReturnValue(null);
    (document.activeElement as HTMLElement)?.blur();
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(false);
    expect(contextTray.clearItems).toHaveBeenCalledWith('editor-selection');
    expect(highlighting.hideSelectionHighlight).toHaveBeenCalledWith(editorView);
  });

  it('preserves selection when input focus arrives after a slow editor blur handoff', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    fireEvent.pointerDown(inputEl);
    editorView.dispatch({ selection: { anchor: 0 } });
    (document.activeElement as HTMLElement)?.blur();

    // Simulate delayed focus handoff under UI load.
    vi.advanceTimersByTime(1250);
    expect(controller.hasSelection()).toBe(true);

    inputEl.focus();
    vi.advanceTimersByTime(250);

    expect(controller.hasSelection()).toBe(true);
    expect(highlighting.hideSelectionHighlight).not.toHaveBeenCalled();
  });

  it('clears selection after handoff grace expires when input never receives focus', () => {
    startPolling(controller);
    vi.advanceTimersByTime(250);

    fireEvent.pointerDown(inputEl);
    editorView.dispatch({ selection: { anchor: 0 } });
    (document.activeElement as HTMLElement)?.blur();

    vi.advanceTimersByTime(1250);
    expect(controller.hasSelection()).toBe(true);

    vi.advanceTimersByTime(750);
    expect(controller.hasSelection()).toBe(false);
    expect(highlighting.hideSelectionHighlight).toHaveBeenCalledWith(editorView);
  });

});

// Preview selections use real browser ranges; the browser highlight registry has no jsdom implementation.
describe('SelectionController preview ranges', () => {
  let app: App;
  let view: MarkdownView;
  let controller: SelectionController;
  let tray: ComposerContextTray;
  let trayEl: HTMLElement;
  let sidebar: HTMLElement;
  let input: HTMLTextAreaElement;
  let source: Text;
  let highlights: Map<string, { ranges: Range[] }>;

  function select(text: Text, from = 0, to = text.length) {
    document.getSelection()!.setBaseAndExtent(text, from, text, to);
    controller.poll();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    highlights = installBrowserHighlights();
    app = new App();
    view = new MarkdownView(new WorkspaceLeaf());
    view.file = Object.assign(new TFile(), { path: 'notes/reading.md' });
    vi.spyOn(view, 'getMode').mockReturnValue('preview');
    document.body.append(view.containerEl);
    source = view.containerEl.appendChild(document.createTextNode('  reading selection\nsecond line  '));
    app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);
    sidebar = document.body.createDiv();
    trayEl = sidebar.createDiv();
    input = sidebar.createEl('textarea', { attr: { 'aria-label': 'Message' } });
    tray = new ComposerContextTray(trayEl);
    controller = new SelectionController(app, tray, input, sidebar);
    controller.start();
  });

  afterEach(() => {
    controller.dispose();
    tray.destroy();
    document.getSelection()!.removeAllRanges();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('preserves raw preview text and omits source line metadata', () => {
    select(source);
    expect(controller.getContext()).toEqual({
      notePath: 'notes/reading.md', mode: 'selection',
      selectedText: '  reading selection\nsecond line  ', lineCount: 2,
    });
    expect(within(trayEl).getByRole('button', { name: 'Remove 2 lines selected' })).toBeDefined();
  });

  it('prefers native selection until its range changes, then highlights the captured range', () => {
    select(source, 2, 19);
    controller.showHighlight();
    expect(highlights.size).toBe(0);
    document.getSelection()!.setBaseAndExtent(source, 20, source, 31);
    controller.showHighlight();
    expect(highlights.get('claudian-selection')!.ranges[0].toString()).toBe('reading selection');
    expect(document.body.classList.contains('claudian-selection-highlight-active')).toBe(true);
  });

  it.each(['input', 'sidebar'])('preserves the preview selection and highlight while %s has focus', target => {
    select(source, 2, 19);
    document.getSelection()!.removeAllRanges();
    const button = sidebar.createEl('button', { text: 'History' });
    (target === 'input' ? input : button).focus();
    vi.mocked(app.workspace.getActiveViewOfType).mockReturnValue(null);
    controller.poll();
    expect(controller.getContext()?.selectedText).toBe('reading selection');
    expect(highlights.get('claudian-selection')!.ranges[0].toString()).toBe('reading selection');
  });

  it('clears selection, the tray and the highlight when deselected outside the chat', () => {
    select(source);
    input.focus();
    expect(highlights.has('claudian-selection')).toBe(true);
    input.blur();
    document.getSelection()!.removeAllRanges();
    controller.poll();
    expect(controller.getContext()).toBeNull();
    expect(within(trayEl).queryByRole('button')).toBeNull();
    expect(highlights.has('claudian-selection')).toBe(false);
    expect(document.body.classList.contains('claudian-selection-highlight-active')).toBe(false);
  });

  it('refreshes the saved range when the same text is reselected elsewhere', () => {
    source.textContent = 'repeat repeat';
    select(source, 0, 6);
    select(source, 7, 13);
    input.focus();
    const range = highlights.get('claudian-selection')!.ranges[0];
    expect(range.startContainer).toBe(source);
    expect(range.startOffset).toBe(7);
    expect(range.endOffset).toBe(13);
    expect(range.toString()).toBe('repeat');
  });

  it.each([false, true])('accepts a cross-container selection with its %s endpoint in the preview', reverse => {
    const outside = document.body.appendChild(document.createTextNode('outside'));
    if (reverse) document.getSelection()!.setBaseAndExtent(source, 2, outside, 7);
    else document.getSelection()!.setBaseAndExtent(outside, 0, source, 2);
    controller.poll();
    expect(controller.hasSelection()).toBe(true);
    expect(controller.getContext()?.selectedText).toContain('reading selection');
  });

  it('ignores selections entirely outside the preview', () => {
    const outside = document.body.appendChild(document.createTextNode('outside'));
    select(outside);
    expect(controller.getContext()).toBeNull();
    expect(within(trayEl).queryByRole('button')).toBeNull();
  });

  it('replaces source line metadata when the same text is selected in preview mode', () => {
    const cm = new EditorView({ parent: document.body.createDiv(), state: EditorState.create({
      doc: 'reading selection', selection: { anchor: 0, head: 17 },
    }) });
    try {
      view.editor = createObsidianEditor(cm);
      vi.mocked(view.getMode).mockReturnValue('source');
      controller.poll();
      expect(controller.getContext()?.startLine).toBe(1);
      vi.mocked(view.getMode).mockReturnValue('preview');
      select(source, 2, 19);
      input.focus();
      expect(controller.getContext()).toEqual({
        notePath: 'notes/reading.md', mode: 'selection', selectedText: 'reading selection', lineCount: 1,
      });
      expect(highlights.get('claudian-selection')!.ranges[0].toString()).toBe('reading selection');
      expect(cm.dom.querySelector('.claudian-selection-highlight')).toBeNull();
    } finally { cm.destroy(); }
  });

  it('drops a removed preview rather than retaining its range and highlight', () => {
    select(source);
    input.focus();
    expect(highlights.has('claudian-selection')).toBe(true);
    view.containerEl.remove();
    input.blur();
    vi.mocked(app.workspace.getActiveViewOfType).mockReturnValue(null);
    controller.poll();
    expect(controller.getContext()).toBeNull();
    expect(highlights.has('claudian-selection')).toBe(false);
  });
});
