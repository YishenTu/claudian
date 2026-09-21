/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';

import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { App, MarkdownView, Notice, TFile } from 'obsidian';

import { AiEditReviewStorage } from '@/app/storage/AiEditReviewStorage';
import type { ToolDiffData } from '@/core/types';
import {
  AiEditHighlightController,
  aiEditHighlightExtension,
} from '@/features/ai-edit-highlights/AiEditHighlightController';
import { createDocumentDiffData } from '@/features/ai-edit-highlights/DocumentDiff';

function createDiff(filePath = 'notes/test.md'): ToolDiffData {
  return {
    filePath,
    diffLines: [
      { type: 'equal', text: 'Before', oldLineNum: 1, newLineNum: 1 },
      { type: 'delete', text: 'Old value', oldLineNum: 2 },
      { type: 'insert', text: 'New value', newLineNum: 2 },
      { type: 'equal', text: 'After', oldLineNum: 3, newLineNum: 3 },
    ],
    stats: { added: 1, removed: 1 },
  };
}

function createDeletionDiff(): ToolDiffData {
  return {
    filePath: 'notes/test.md',
    diffLines: [
      { type: 'equal', text: 'Before', oldLineNum: 1, newLineNum: 1 },
      { type: 'delete', text: 'Removed value', oldLineNum: 2 },
      { type: 'equal', text: 'After', oldLineNum: 3, newLineNum: 2 },
    ],
    stats: { added: 0, removed: 1 },
  };
}

function createAdditionDiff(): ToolDiffData {
  return {
    filePath: 'notes/test.md',
    diffLines: [
      { type: 'equal', text: 'Before', oldLineNum: 1, newLineNum: 1 },
      { type: 'insert', text: 'Added value', newLineNum: 2 },
      { type: 'equal', text: 'After', oldLineNum: 2, newLineNum: 3 },
    ],
    stats: { added: 1, removed: 0 },
  };
}

function createEditor(text: string, path = 'notes/test.md') {
  const parent = document.body.createDiv();
  const editorView = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [aiEditHighlightExtension],
    }),
  });
  const markdownView = Object.assign(Object.create(MarkdownView.prototype), {
    editor: { cm: editorView },
    file: createTFile(path),
  }) as MarkdownView;
  return { editorView, markdownView, parent };
}

function createTFile(path: string): TFile {
  const name = path.split('/').at(-1) ?? path;
  return Object.assign(Object.create(TFile.prototype), {
    path,
    name,
    basename: name.replace(/\.[^.]+$/, ''),
    extension: name.split('.').at(-1) ?? '',
  }) as TFile;
}

function createReviewStorage() {
  const files = new Map<string, string>();
  const adapter = {
    exists: async (path: string) => files.has(path),
    read: async (path: string) => files.get(path)!,
    write: async (path: string, content: string) => { files.set(path, content); },
    delete: async (path: string) => { files.delete(path); },
    rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
  };
  return new AiEditReviewStorage(adapter);
}

describe('AiEditHighlightController', () => {
  let app: App;
  let leaves: Array<{ view: MarkdownView }>;
  let controller: AiEditHighlightController;
  const editors: EditorView[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    leaves = [];
    app = new App();
    app.workspace.getLeavesOfType = jest.fn(() => leaves) as any;
    controller = new AiEditHighlightController(app);
  });

  afterEach(() => {
    controller.dispose();
    editors.splice(0).forEach(editor => editor.destroy());
    document.body.replaceChildren();
  });

  it('disables capture and visibility without deleting pending reviews', () => {
    const { editorView, markdownView, parent } = createEditor('Before\nNew value\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });

    controller.setEnabled(false);
    controller.recordDiffs([createDiff()]);
    expect(controller.hasHighlights()).toBe(false);
    expect(within(parent).queryByRole('region')).toBeNull();

    controller.setEnabled(true);
    controller.recordDiffs([createDiff()]);
    expect(within(parent).getByRole('region')).toBeDefined();
    controller.setEnabled(false);
    expect(controller.hasHighlights()).toBe(true);
    expect(within(parent).queryByRole('region')).toBeNull();

    controller.setEnabled(true);
    expect(within(parent).getByRole('region')).toBeDefined();
  });

  it('does not scan the Vault while the experimental feature is disabled', async () => {
    app.vault.getMarkdownFiles = jest.fn(() => [createTFile('notes/test.md')]);
    app.vault.read = jest.fn(async () => 'Original');
    controller.setEnabled(false);

    await controller.beginVaultCapture('disabled-turn');
    await controller.completeVaultCapture('disabled-turn');

    expect(app.vault.getMarkdownFiles).not.toHaveBeenCalled();
    expect(app.vault.read).not.toHaveBeenCalled();
  });

  it.each([
    ['cm-embed-block math-block', '$$\nx^2\n$$', '$$\nx^3\n$$', 'Accept change'],
    ['cm-embed-block cm-callout', '> [!summary]\n> Old value\n> Tail', '> [!summary]\n> New value\n> Tail', 'Accept change'],
    ['cm-embed-block cm-callout', '> [!summary]\n> Old value\n> Tail', '> [!summary]\n> New value\n> Tail', 'Revert change'],
    ['cm-embed-block math-block', '', '$$\nx^2\n$$', 'Revert change'],
  ])('keeps reviews visible when Live Preview replaces %s: %s', async (className, original, current, action) => {
    const before = original ? `Before\n${original}\nAfter` : 'Before\nAfter';
    const after = `Before\n${current}\nAfter`;
    const { editorView, markdownView, parent } = createEditor(after);
    editors.push(editorView);
    leaves.push({ view: markdownView });
    class PreviewWidget extends WidgetType {
      toDOM() {
        const element = document.createElement('div');
        element.className = className;
        element.textContent = 'Rendered content';
        return element;
      }
    }
    const preview = StateField.define({
      create: () => Decoration.none,
      update: (_, transaction) => transaction.state.selection.main.head === 0 && transaction.state.doc.lines >= 5
        ? Decoration.set([Decoration.replace({ widget: new PreviewWidget(), block: true }).range(
          transaction.state.doc.line(2).from, transaction.state.doc.line(4).to,
        )]) : Decoration.none,
      provide: field => EditorView.decorations.from(field),
    });
    editorView.dispatch({ effects: StateEffect.appendConfig.of(preview) });
    controller.recordDiffs([createDocumentDiffData('notes/test.md', before, after)!]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(parent.querySelector('.cm-embed-block')?.classList.contains('claudian-ai-edit-highlight')).toBe(true);
    expect(within(parent).getByRole('region').textContent).toContain(original.split('\n')[1] ?? '');
    // Host renderers may rebuild their children asynchronously, without a transaction.
    parent.querySelector('.cm-embed-block')!.replaceChildren(document.createTextNode('Rendered again'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(within(parent).getAllByRole('region')).toHaveLength(1);
    editorView.dispatch({ selection: { anchor: editorView.state.doc.line(3).from } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(within(parent).getAllByRole('region')).toHaveLength(1);
    editorView.dispatch({ selection: { anchor: 0 } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(within(parent).getAllByRole('region')).toHaveLength(1);
    fireEvent.click(within(parent).getByRole('button', { name: action }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(within(parent).queryByRole('region')).toBeNull();
    expect(parent.querySelector('.claudian-ai-edit-highlight')).toBeNull();
    expect(editorView.state.doc.toString()).toBe(action === 'Accept change' ? after : before);
  });

  it.each(['Accept change', 'Revert change'])('restores pending reviews after restart and persists %s', async (action) => {
    const storage = createReviewStorage();
    const { editorView, markdownView, parent } = createEditor('Before\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    controller.recordDiffs([createDeletionDiff()]);
    await storage.flush();
    controller.dispose();
    await storage.flush();
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    const review = within(parent).getByRole('region', { name: 'Deleted AI change review' });
    expect(review.textContent).toContain('Removed value');
    fireEvent.click(within(review).getByRole('button', { name: action }));
    await controller.flush();
    controller.dispose();
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    expect(within(parent).queryByRole('region')).toBeNull();
    expect(editorView.state.doc.toString()).toBe(action === 'Accept change'
      ? 'Before\nAfter' : 'Before\nRemoved value\nAfter');
  });

  it('highlights a formula rendered as a zero-length host widget with hidden source', async () => {
    const { editorView, markdownView, parent } = createEditor('Before\n$$x^3$$\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    class FormulaWidget extends WidgetType {
      toDOM() {
        const element = document.createElement('div');
        element.className = 'math math-block cm-embed-block';
        element.textContent = 'Rendered formula';
        return element;
      }
    }
    const formula = editorView.state.doc.line(2);
    const preview = StateField.define({
      create: () => Decoration.set([
        Decoration.widget({ widget: new FormulaWidget(), block: true, side: -1 }).range(formula.from),
        Decoration.replace({}).range(formula.from, formula.to),
      ], true),
      update: value => value,
      provide: field => EditorView.decorations.from(field),
    });
    editorView.dispatch({ effects: StateEffect.appendConfig.of(preview) });
    controller.recordDiffs([createDocumentDiffData('notes/test.md', 'Before\n$$x^2$$\nAfter', 'Before\n$$x^3$$\nAfter')!]);
    await new Promise(resolve => setTimeout(resolve, 0));
    const block = parent.querySelector<HTMLElement>('.math-block')!;
    expect(editorView.posAtDOM(block, 0)).toBe(editorView.posAtDOM(block, block.childNodes.length));
    expect(block.classList.contains('claudian-ai-edit-highlight')).toBe(true);
    expect(within(parent).getAllByRole('region')).toHaveLength(1);
  });

  it('captures an unreported command addition to an empty note and restores it after restart', async () => {
    const storage = createReviewStorage();
    const { editorView, markdownView, parent } = createEditor('');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    jest.useFakeTimers();
    try {
      controller.beginOpenEditorCapture('turn-1', true);
      editorView.dispatch({ changes: { from: 0, insert: '# Test\n\nNew paragraph\n' } });
      controller.completeOpenEditorCapture('turn-1', true);
      jest.runAllTimers();
    } finally {
      jest.useRealTimers();
    }
    expect(parent.querySelectorAll('.claudian-ai-edit-highlight--added')).toHaveLength(4);
    await controller.flush();
    controller.dispose();
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    expect(parent.querySelectorAll('.claudian-ai-edit-highlight--added')).toHaveLength(4);
    fireEvent.click(within(parent).getByRole('button', { name: 'Revert change' }));
    expect(editorView.state.doc.toString()).toBe('');
    await controller.flush();
  });

  it.each(['Accept change', 'Revert change'])('retains the first original durably on %s and keeps other paragraphs', async (action) => {
    const storage = createReviewStorage();
    const before = 'Start\nOriginal\nMiddle\nOther old\nEnd';
    const first = 'Start\nFirst edit\nMiddle\nOther edit\nEnd';
    const second = 'Start\nLatest edit\nMiddle\nOther edit\nEnd';
    const { editorView, markdownView, parent } = createEditor(first);
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    controller.recordDiffs([createDocumentDiffData('notes/test.md', before, first)!]);
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: second } });
    controller.recordDiffs([createDocumentDiffData('notes/test.md', first, second)!]);
    await controller.flush();
    controller.dispose();
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    const review = within(parent).getByText('Original').closest<HTMLElement>('[role="region"]')!;
    fireEvent.click(within(review).getByRole('button', { name: action }));
    await controller.flush();
    controller.dispose();
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    expect(within(parent).getAllByRole('region')).toHaveLength(1);
    expect(within(parent).getByRole('region').textContent).toContain('Other old');
    expect(editorView.state.doc.toString()).toBe(action === 'Accept change' ? second : 'Start\nOriginal\nMiddle\nOther edit\nEnd');
    // Returning to the prior intermediate text must not revive an old review.
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: first } });
    controller.handleFileOpened(markdownView.file);
    expect(within(parent).getAllByRole('region')).toHaveLength(1);
  });

  it.each([
    ['Before\nRemoved\nAfter', 'Before\nAfter', 'Before\nReplacement\nAfter'],
    ['Before\nAfter', 'Before\nAdded\nAfter', 'Before\nAfter'],
    ['Before\nAfter', 'Before\nFirst\nSecond\nAfter', 'Before\nChanged\nSecond\nAfter'],
  ])('replaces the pending region across addition and deletion transitions from %s', (original, first, latest) => {
    const { editorView, markdownView, parent } = createEditor(first);
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([createDocumentDiffData('notes/test.md', original, first)!]);
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: latest } });
    controller.recordDiffs([createDocumentDiffData('notes/test.md', first, latest)!]);
    expect(within(parent).queryAllByRole('region')).toHaveLength(original === latest ? 0 : 1);
    if (original !== latest) {
      fireEvent.click(within(parent).getByRole('button', { name: 'Revert change' }));
    }
    expect(editorView.state.doc.toString()).toBe(original);
    expect(controller.hasHighlights()).toBe(false);
    expect(within(parent).queryByRole('region')).toBeNull();
  });

  it('persists version 2 W3C anchors and maps them through programmatic typing', async () => {
    const storage = createReviewStorage();
    const original = [
      'Section A', 'Shared before', 'Old value', 'Shared after',
      'Section B', 'Shared before', 'Old value', 'Shared after',
    ].join('\n');
    const current = [
      'Section A', 'Shared before', 'Old value', 'Shared after',
      'Section B', 'Shared before', 'New value', 'Shared after',
    ].join('\n');
    const { editorView, markdownView, parent } = createEditor(current);
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    controller.recordDiffs([createDocumentDiffData('notes/test.md', original, current)!]);
    await controller.flush();
    const beforeInsert = await storage.load() as any;
    const initialStart = beforeInsert.reviews[0].anchor.position.start;

    // No userEvent annotation: formatters and other plugins commonly dispatch this way.
    editorView.dispatch({ changes: { from: 0, insert: 'Inserted heading\n' } });
    await Promise.resolve();
    await controller.flush();
    const persisted = await storage.load() as any;
    expect(persisted.version).toBe(2);
    expect(persisted.reviews[0].anchor).toMatchObject({
      position: { type: 'TextPositionSelector' },
      quote: { type: 'TextQuoteSelector', exact: 'New value' },
    });
    expect(persisted.reviews[0].anchor.position.start).toBeGreaterThan(initialStart);

    controller.dispose();
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    fireEvent.click(within(parent).getByRole('button', { name: 'Revert change' }));
    expect(editorView.state.doc.toString()).toBe(`Inserted heading\n${original}`);
  });

  it('migrates a version 1 review to version 2 selectors after resolving it', async () => {
    const storage = createReviewStorage();
    await storage.save({ version: 1, reviews: [{
      path: 'notes/test.md',
      kind: 'modified',
      originalLines: ['Old value'],
      currentLines: ['New value'],
      beforeText: 'Before',
      afterText: 'After',
      hintedLine: 2,
      hintedLineIsExact: true,
    }] });
    const { editorView, markdownView } = createEditor('Before\nNew value\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller = new AiEditHighlightController(app, storage);

    await controller.initialize();
    await controller.flush();

    const migrated = await storage.load() as any;
    expect(migrated.version).toBe(2);
    expect(migrated.reviews[0].anchor.quote.exact).toBe('New value');
  });

  it('decorates modified content in an already open Markdown editor', () => {
    const { editorView, markdownView, parent } = createEditor('Before\nNew value\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });

    controller.recordDiffs([createDiff()]);

    const highlightedLine = parent.querySelector('.claudian-ai-edit-highlight--modified');
    expect(highlightedLine?.textContent).toBe('New value');
    expect(highlightedLine?.getAttribute('data-claudian-ai-edit-kind')).toBe('modified');
  });

  it('reviews an unopened note after a failed task and preserves its first original across turns', async () => {
    const file = createTFile('notes/closed.md');
    let text = 'Start\nOriginal\nEnd';
    app.vault.getMarkdownFiles = () => [file];
    app.vault.getFileByPath = path => path === file.path ? file : null;
    app.vault.read = async () => text;
    await controller.beginVaultCapture('turn-1');
    text = 'Start\nIntermediate\nEnd';
    await controller.completeVaultCapture('turn-1');
    await controller.beginVaultCapture('turn-2');
    text = 'Start\nLatest\nEnd';
    await controller.completeVaultCapture('turn-2');
    const { editorView, markdownView, parent } = createEditor(text, file.path);
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.handleFileOpened(file);
    expect(within(parent).getByText('Original')).toBeDefined();
    expect(within(parent).queryByText('Intermediate')).toBeNull();
    fireEvent.click(within(parent).getByRole('button', { name: 'Revert change' }));
    expect(editorView.state.doc.toString()).toBe('Start\nOriginal\nEnd');
  });

  it('keeps earlier pending changes visible after a shell edit switches the file to CRLF', async () => {
    const original = 'Header\nalpha + beta = gamma\nMiddle\n123456\nFooter\n';
    const first = 'Header\ndelta + epsilon = zeta\nMiddle\n123456\nFooter\n';
    const final = 'Header\ndelta + epsilon = zeta\nMiddle\n654321\nFooter\n';
    const file = createTFile('notes/test.md');
    let disk = first;
    app.vault.getMarkdownFiles = () => [file];
    app.vault.getFileByPath = () => file;
    app.vault.read = async () => disk;
    const { editorView, markdownView, parent } = createEditor(first);
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([createDocumentDiffData(file.path, original, first)!]);
    await controller.beginVaultCapture('turn');
    disk = final.replace(/\n/g, '\r\n');
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: final } });
    await controller.completeVaultCapture('turn');
    expect(within(parent).getAllByRole('region')).toHaveLength(2);
    expect(within(parent).getByText('alpha + beta = gamma')).toBeDefined();
    expect(within(parent).getByText('123456')).toBeDefined();
    expect(parent.querySelectorAll('.claudian-ai-edit-highlight')).toHaveLength(2);
  });

  it('does not create a review when only line endings change', async () => {
    const file = createTFile('notes/test.md');
    let disk = 'Header\nBody\n';
    app.vault.getMarkdownFiles = () => [file];
    app.vault.getFileByPath = () => file;
    app.vault.read = async () => disk;
    await controller.beginVaultCapture('turn');
    disk = 'Header\r\nBody\r\n';
    await controller.completeVaultCapture('turn');
    expect(controller.hasHighlights()).toBe(false);
  });

  it('repairs saved CRLF-contaminated reviews into precise blocks without losing original text', async () => {
    const storage = createReviewStorage();
    await storage.save({ version: 1, reviews: [{
      path: 'notes/test.md', kind: 'modified', hintedLine: 3, hintedLineIsExact: true,
      originalLines: ['Header', 'alpha', 'Middle', '123456', 'Footer'],
      currentLines: ['Header\r', 'delta\r', 'Middle\r', '654321\r', 'Footer\r'],
    }] });
    const { editorView, markdownView, parent } = createEditor('Preface\n\nHeader\ndelta\nMiddle\n654321\nFooter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    expect(within(parent).getAllByRole('region')).toHaveLength(2);
    expect(within(parent).getByText('alpha')).toBeDefined();
    expect(within(parent).getByText('123456')).toBeDefined();
    expect(parent.querySelectorAll('.claudian-ai-edit-highlight')).toHaveLength(2);
  });

  it('safely splits a persisted oversized modified review during restoration', async () => {
    const storage = createReviewStorage();
    const originalLines = Array.from({ length: 501 }, (_, index) => `Line ${index + 50}`);
    const currentLines = [...originalLines];
    currentLines[0] = 'Revised first endpoint';
    currentLines[currentLines.length - 1] = 'Revised last endpoint';
    await storage.save({ version: 1, reviews: [{
      path: 'notes/test.md', kind: 'modified', hintedLine: 50, hintedLineIsExact: true,
      beforeText: 'Prefix', afterText: 'Suffix', originalLines, currentLines,
    }] });
    const current = ['Prefix', ...currentLines, 'Suffix'].join('\n');
    const { editorView, markdownView } = createEditor(current);
    editors.push(editorView);
    leaves.push({ view: markdownView });

    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    await controller.flush();

    const repaired = await storage.load() as { reviews: Array<{
      originalLines: string[];
      currentLines: string[];
    }> };
    expect(repaired.reviews).toHaveLength(2);
    expect(repaired.reviews.every(review => (
      review.originalLines.length === 1 && review.currentLines.length === 1
    ))).toBe(true);
    controller.dispose();
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    const restored = await storage.load() as { reviews: unknown[] };
    expect(restored.reviews).toHaveLength(2);
  });

  it('keeps endpoint reviews when the user edits an unchanged line between them', async () => {
    const storage = createReviewStorage();
    const original = Array.from({ length: 600 }, (_, index) => `Line ${index + 1}`).join('\n');
    const revised = original.split('\n');
    revised[49] = 'AI revised line 50';
    revised[549] = 'AI revised line 550';
    const current = revised.join('\n');
    const { editorView, markdownView } = createEditor(current);
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.dispose();
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    controller.recordDiffs([createDocumentDiffData('notes/test.md', original, current)!]);

    const middle = editorView.state.doc.line(300);
    editorView.dispatch({
      changes: { from: middle.from, to: middle.to, insert: 'Manual line 300' },
      userEvent: 'input.type',
    });
    await Promise.resolve();
    await controller.flush();

    const persisted = await storage.load() as { reviews: unknown[] };
    expect(persisted.reviews).toHaveLength(2);
  });

  it('keeps an earlier middle review separate from later distant changes', async () => {
    const storage = createReviewStorage();
    const original = Array.from({ length: 600 }, (_, index) => `Line ${index + 1}`).join('\n');
    const firstLines = original.split('\n');
    firstLines[299] = 'Earlier AI revision';
    const first = firstLines.join('\n');
    const latestLines = [...firstLines];
    latestLines[49] = 'AI revised line 50';
    latestLines[549] = 'AI revised line 550';
    const latest = latestLines.join('\n');
    const { editorView, markdownView } = createEditor(first);
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.dispose();
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();
    controller.recordDiffs([createDocumentDiffData('notes/test.md', original, first)!]);
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: latest } });
    controller.recordDiffs([createDocumentDiffData('notes/test.md', first, latest)!]);
    await controller.flush();

    const persisted = await storage.load() as { reviews: unknown[] };
    expect(persisted.reviews).toHaveLength(3);
  });

  it('preserves existing reviews when a full-document comparison exceeds its budget', async () => {
    const storage = createReviewStorage();
    const beforeLines = Array.from({ length: 2_000 }, (_, index) => `Before ${index + 1}`);
    beforeLines[0] = 'Pending current';
    let disk = beforeLines.join('\n');
    const file = createTFile('notes/test.md');
    app.vault.getMarkdownFiles = () => [file];
    app.vault.getFileByPath = path => path === file.path ? file : null;
    app.vault.read = async () => disk;
    await storage.save({ version: 1, reviews: [{
      path: file.path,
      kind: 'modified',
      originalLines: ['Before 1'],
      currentLines: ['Pending current'],
      hintedLine: 1,
      hintedLineIsExact: true,
      afterText: 'Before 2',
    }] });
    controller.dispose();
    controller = new AiEditHighlightController(app, storage);
    await controller.initialize();

    await controller.beginVaultCapture('large-rewrite');
    disk = Array.from({ length: 2_000 }, (_, index) => `After ${index + 1}`).join('\n');
    await controller.completeVaultCapture('large-rewrite');

    const persisted = await storage.load() as { reviews: Array<{
      originalLines: string[];
      currentLines: string[];
    }> };
    expect(persisted.reviews).toHaveLength(1);
    expect(persisted.reviews[0]).toMatchObject({
      originalLines: ['Before 1'],
      currentLines: ['Pending current'],
    });
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('too large'));
  });

  it('keeps an earlier formula review at its location when a later edit removes a repeated formula', () => {
    const original = 'Header\nalpha\n\n123456\ndelta\n123456\n';
    const first = 'Header\ndelta\n\n123456\ndelta\n123456\n';
    const latest = 'Header\ndelta\n\n654321\n';
    const { editorView, markdownView, parent } = createEditor(first);
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([createDocumentDiffData('notes/test.md', original, first)!]);
    editorView.dispatch({ changes: { from: 0, to: first.length, insert: latest } });
    controller.recordDiffs([createDocumentDiffData('notes/test.md', first, latest)!]);
    const formula = within(parent).getByText('alpha').closest<HTMLElement>('[role="region"]')!;
    expect(formula.getAttribute('aria-label')).toBe('Modified AI change review');
    expect(parent.querySelectorAll('.claudian-ai-edit-highlight')).toHaveLength(2);
    fireEvent.click(within(formula).getByRole('button', { name: 'Revert change' }));
    expect(editorView.state.doc.toString()).toBe('Header\nalpha\n\n654321\n');
  });

  it('keeps a renamed unopened note anchored and captures new files in concurrent turns', async () => {
    const file = createTFile('notes/old.md');
    const added = createTFile('notes/new.md');
    const files = new Map([[file.path, 'Before\nOriginal\nAfter']]);
    app.vault.getMarkdownFiles = () => [file, added].filter(item => files.has(item.path));
    app.vault.getFileByPath = path => [file, added].find(item => item.path === path && files.has(path)) ?? null;
    app.vault.read = async item => files.get(item.path)!;
    await controller.beginVaultCapture('first');
    await controller.beginVaultCapture('second');
    controller.handleFileModified(file);
    files.delete(file.path);
    const oldPath = file.path;
    file.path = 'notes/renamed.md';
    files.set(file.path, 'Before\nLatest\nAfter');
    controller.handleFileRenamed(file, oldPath);
    await controller.completeVaultCapture('first');
    files.set(added.path, 'New note');
    await controller.completeVaultCapture('second');
    const renamed = createEditor(files.get(file.path)!, file.path);
    const created = createEditor('New note', added.path);
    editors.push(renamed.editorView, created.editorView);
    leaves.push({ view: renamed.markdownView }, { view: created.markdownView });
    controller.handleFileOpened(file);
    controller.handleFileOpened(added);
    expect(within(renamed.parent).getByText('Original')).toBeDefined();
    expect(within(created.parent).getByRole('region', { name: 'Added AI change review' })).toBeDefined();
  });

  it('excludes manual edits during capture even when the editor has not saved yet', async () => {
    const original = 'Before\nOriginal\nAfter';
    const first = 'Before\nAI wording\nAfter';
    const file = createTFile('notes/test.md');
    let disk = original;
    app.vault.getMarkdownFiles = () => [file];
    app.vault.getFileByPath = () => file;
    app.vault.read = async () => disk;
    const { editorView, markdownView, parent } = createEditor(original);
    editors.push(editorView);
    leaves.push({ view: markdownView });
    await controller.beginVaultCapture('turn');
    disk = first;
    editorView.dispatch({ changes: { from: 0, to: original.length, insert: first } });
    controller.handleFileModified(file);
    await controller.flush();
    const line = editorView.state.doc.line(2);
    editorView.dispatch({ changes: { from: line.from, to: line.to, insert: 'My wording' }, userEvent: 'input.type' });
    await controller.flush();
    await controller.completeVaultCapture('turn');
    expect(controller.hasHighlights()).toBe(false);
    expect(within(parent).queryByRole('region')).toBeNull();
    disk = editorView.state.doc.toString();
    await controller.beginVaultCapture('next');
    disk = 'Before\nFinal AI wording\nAfter';
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: disk } });
    await controller.completeVaultCapture('next');
    expect(within(parent).getByText('My wording')).toBeDefined();
  });

  it('does not attribute idle changes to a later task', async () => {
    const file = createTFile('notes/closed.md');
    let disk = 'Original';
    app.vault.getMarkdownFiles = () => [file];
    app.vault.getFileByPath = () => file;
    app.vault.read = async () => disk;
    await controller.beginVaultCapture('first');
    await controller.completeVaultCapture('first');
    disk = 'Manually edited while idle';
    controller.handleFileModified(file);
    await controller.beginVaultCapture('second');
    await controller.completeVaultCapture('second');
    expect(controller.hasHighlights()).toBe(false);
  });

  it('ignores intermediate autosaves from consecutive manual edits', async () => {
    const file = createTFile('notes/test.md');
    let disk = 'Original';
    app.vault.getMarkdownFiles = () => [file];
    app.vault.getFileByPath = () => file;
    app.vault.read = async () => disk;
    const { editorView, markdownView } = createEditor(disk);
    editors.push(editorView);
    leaves.push({ view: markdownView });
    await controller.beginVaultCapture('turn');
    editorView.dispatch({ changes: { from: 0, to: 8, insert: 'First manual draft' }, userEvent: 'input.type' });
    await controller.flush();
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: 'Final manual draft' }, userEvent: 'input.type' });
    await controller.flush();
    disk = 'First manual draft';
    controller.handleFileModified(file);
    await controller.flush();
    expect(controller.hasHighlights()).toBe(false);
    disk = 'Final manual draft';
    await controller.completeVaultCapture('turn');
    expect(controller.hasHighlights()).toBe(false);
  });

  it('does not invent an original when initial file access fails', async () => {
    const file = createTFile('notes/closed.md');
    let readable = false;
    app.vault.getMarkdownFiles = () => [file];
    app.vault.getFileByPath = () => file;
    app.vault.read = async () => {
      if (!readable) throw new Error('Unavailable');
      return 'Existing content';
    };
    await controller.beginVaultCapture('turn');
    readable = true;
    await controller.completeVaultCapture('turn');
    expect(controller.hasHighlights()).toBe(false);
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
  });

  it('dismisses only the manually edited block and uses that text as the next original', async () => {
    const original = 'Start\nOriginal\nMiddle\nOther old\nEnd';
    const first = 'Start\nFirst edit\nMiddle\nOther edit\nEnd';
    const { editorView, markdownView, parent } = createEditor(first);
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([createDocumentDiffData('notes/test.md', original, first)!]);
    const line = editorView.state.doc.line(2);
    editorView.dispatch({
      changes: { from: line.from, to: line.to, insert: 'My wording' },
      annotations: Transaction.userEvent.of('input.type'),
    });
    await Promise.resolve();
    expect(within(parent).getAllByRole('region')).toHaveLength(1);
    expect(within(parent).getByRole('region').textContent).toContain('Other old');
    const manual = editorView.state.doc.toString();
    const latest = 'Start\nFinal wording\nMiddle\nOther edit\nEnd';
    editorView.dispatch({ changes: { from: 0, to: manual.length, insert: latest } });
    controller.recordDiffs([createDocumentDiffData('notes/test.md', manual, latest)!]);
    expect(within(parent).getByText('My wording')).toBeDefined();
    expect(within(parent).queryByText('Original')).toBeNull();
  });

  it('maps untouched review anchors through manual typing and dismisses deletion boundaries', async () => {
    const { editorView, markdownView, parent } = createEditor('Before\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([createDeletionDiff()]);
    editorView.dispatch({ changes: { from: 0, insert: 'Preface\n' }, userEvent: 'input.paste' });
    await Promise.resolve();
    expect(within(parent).getByText('Removed value')).toBeDefined();
    editorView.dispatch({ changes: { from: editorView.state.doc.line(3).from, insert: 'Manual\n' }, userEvent: 'input.type' });
    await Promise.resolve();
    expect(controller.hasHighlights()).toBe(false);
    expect(within(parent).queryByRole('region')).toBeNull();
  });

  it('shows original modified content below the highlight with accessible actions', async () => {
    const { editorView, markdownView, parent } = createEditor('Before\nNew value\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });

    controller.recordDiffs([createDiff()]);

    const review = parent.querySelector<HTMLElement>('.claudian-ai-edit-review--modified')!;
    expect(review.textContent).toContain('Old value');
    expect(within(review).getByRole('button', { name: 'Accept change' })).toBeDefined();
    expect(within(review).getByRole('button', { name: 'Revert change' })).toBeDefined();
    expect((await axe(review)).violations).toEqual([]);
  });

  it('expands long deleted content and reverts all lines from the compact review', () => {
    const { editorView, markdownView, parent } = createEditor('Before\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([{
      filePath: 'notes/test.md',
      diffLines: [
        { type: 'equal', text: 'Before', oldLineNum: 1, newLineNum: 1 },
        { type: 'delete', text: 'First removed', oldLineNum: 2 },
        { type: 'delete', text: 'Second removed', oldLineNum: 3 },
        { type: 'delete', text: 'Third removed', oldLineNum: 4 },
        { type: 'equal', text: 'After', oldLineNum: 5, newLineNum: 2 },
      ],
      stats: { added: 0, removed: 3 },
    }]);
    const expand = within(parent).getByRole('button', { name: 'Show 1 more deleted line' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(within(parent).getByText('Third removed').closest('[hidden]')).not.toBeNull();
    fireEvent.click(expand);
    expect(expand.getAttribute('aria-expanded')).toBe('true');
    expect(within(parent).getByText('Third removed').closest('[hidden]')).toBeNull();
    fireEvent.click(within(parent).getByRole('button', { name: 'Show fewer deleted lines' }));
    expect(within(parent).getByText('Third removed').closest('[hidden]')).not.toBeNull();
    fireEvent.click(within(parent).getByRole('button', { name: 'Revert change' }));
    expect(editorView.state.doc.toString()).toBe('Before\nFirst removed\nSecond removed\nThird removed\nAfter');
  });

  it('shows deleted content at its original boundary without highlighting a surviving line', () => {
    const { editorView, markdownView, parent } = createEditor('Before\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });

    controller.recordDiffs([createDeletionDiff()]);

    const review = parent.querySelector<HTMLElement>('.claudian-ai-edit-review--deleted')!;
    expect(review.textContent).toContain('Removed value');
    expect(parent.querySelector('.claudian-ai-edit-highlight--deleted')).toBeNull();
    expect(within(review).getByRole('button', { name: 'Accept change' })).toBeDefined();
    expect(within(review).getByRole('button', { name: 'Revert change' })).toBeDefined();
  });

  it('shows a context-free modified review at its exact document line', () => {
    const { editorView, markdownView, parent } = createEditor(
      'Repeated value\nMiddle\nRepeated value',
    );
    editors.push(editorView);
    leaves.push({ view: markdownView });

    controller.recordDiffs([{
      filePath: 'notes/test.md',
      diffLines: [
        { type: 'delete', text: 'Old value', oldLineNum: 3 },
        { type: 'insert', text: 'Repeated value', newLineNum: 3 },
      ],
      lineNumbersAreDocumentRelative: true,
      stats: { added: 1, removed: 1 },
    }]);

    const review = parent.querySelector<HTMLElement>('.claudian-ai-edit-review--modified')!;
    expect(review).not.toBeNull();
    expect(review.textContent).toContain('Old value');
    expect(within(review).getByRole('button', { name: 'Accept change' })).toBeDefined();
    const editorLines = Array.from(parent.querySelectorAll<HTMLElement>('.cm-line'));
    expect(editorLines[0].classList.contains('claudian-ai-edit-highlight--modified')).toBe(false);
    expect(editorLines[2].classList.contains('claudian-ai-edit-highlight--modified')).toBe(true);
  });

  it('shows a context-free deleted review at its exact document boundary', () => {
    const { editorView, markdownView, parent } = createEditor('First\nSecond\nFourth');
    editors.push(editorView);
    leaves.push({ view: markdownView });

    controller.recordDiffs([{
      filePath: 'notes/test.md',
      diffLines: [{ type: 'delete', text: 'Third', oldLineNum: 3 }],
      lineNumbersAreDocumentRelative: true,
      stats: { added: 0, removed: 1 },
    }]);

    const review = parent.querySelector<HTMLElement>('.claudian-ai-edit-review--deleted')!;
    expect(review).not.toBeNull();
    expect(review.textContent).toContain('Third');
    fireEvent.click(within(review).getByRole('button', { name: 'Revert change' }));
    expect(editorView.state.doc.toString()).toBe('First\nSecond\nThird\nFourth');
  });

  it('keeps a context-free deletion anchored when lines are inserted before it', () => {
    const { editorView, markdownView, parent } = createEditor('First\nSecond\nFourth');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([{
      filePath: 'notes/test.md',
      diffLines: [{ type: 'delete', text: 'Third', oldLineNum: 3 }],
      lineNumbersAreDocumentRelative: true,
      stats: { added: 0, removed: 1 },
    }]);
    const revertButton = within(parent).getByRole('button', { name: 'Revert change' });

    editorView.dispatch({ changes: { from: 0, to: 0, insert: 'Intro\n' } });
    fireEvent.click(revertButton);

    expect(editorView.state.doc.toString()).toBe('Intro\nFirst\nSecond\nThird\nFourth');
  });

  it('accepts one change by removing only its review highlight', () => {
    const { editorView, markdownView, parent } = createEditor('Before\nNew value\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([createDiff()]);

    fireEvent.click(within(parent).getByRole('button', { name: 'Accept change' }));

    expect(editorView.state.doc.toString()).toBe('Before\nNew value\nAfter');
    expect(parent.querySelector('.claudian-ai-edit-highlight')).toBeNull();
    expect(parent.querySelector('.claudian-ai-edit-review')).toBeNull();
    expect(controller.hasHighlights()).toBe(false);
  });

  it('reverts a modification and removes its review highlight', () => {
    const { editorView, markdownView, parent } = createEditor('Before\nNew value\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([createDiff()]);

    fireEvent.click(within(parent).getByRole('button', { name: 'Revert change' }));

    expect(editorView.state.doc.toString()).toBe('Before\nOld value\nAfter');
    expect(parent.querySelector('.claudian-ai-edit-review')).toBeNull();
    expect(controller.hasHighlights()).toBe(false);
  });

  it('refuses to revert when the highlighted text changed after review creation', () => {
    const { editorView, markdownView, parent } = createEditor('Before\nNew value\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([createDiff()]);
    const revertButton = within(parent).getByRole('button', { name: 'Revert change' });
    const changedLine = editorView.state.doc.line(2);
    editorView.dispatch({
      changes: { from: changedLine.from, to: changedLine.to, insert: 'Manual value' },
    });

    fireEvent.click(revertButton);

    expect(editorView.state.doc.toString()).toBe('Before\nManual value\nAfter');
    expect(Notice).toHaveBeenCalledWith(
      'Cannot revert this AI change because the surrounding content changed.',
    );
  });

  it('reverts a deletion at the exact original boundary', () => {
    const { editorView, markdownView, parent } = createEditor('Before\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([createDeletionDiff()]);

    fireEvent.click(within(parent).getByRole('button', { name: 'Revert change' }));

    expect(editorView.state.doc.toString()).toBe('Before\nRemoved value\nAfter');
    expect(parent.querySelector('.claudian-ai-edit-review')).toBeNull();
  });

  it('reverts deletions at the beginning and end of a document', () => {
    const first = createEditor('After');
    editors.push(first.editorView);
    leaves.push({ view: first.markdownView });
    controller.recordDiffs([{
      filePath: 'notes/test.md',
      diffLines: [
        { type: 'delete', text: 'Removed first', oldLineNum: 1 },
        { type: 'equal', text: 'After', oldLineNum: 2, newLineNum: 1 },
      ],
      stats: { added: 0, removed: 1 },
    }]);
    fireEvent.click(within(first.parent).getByRole('button', { name: 'Revert change' }));
    expect(first.editorView.state.doc.toString()).toBe('Removed first\nAfter');

    controller.clearAll();
    leaves.splice(0);
    const last = createEditor('Before');
    editors.push(last.editorView);
    leaves.push({ view: last.markdownView });
    controller.recordDiffs([{
      filePath: 'notes/test.md',
      diffLines: [
        { type: 'equal', text: 'Before', oldLineNum: 1, newLineNum: 1 },
        { type: 'delete', text: 'Removed last', oldLineNum: 2 },
      ],
      stats: { added: 0, removed: 1 },
    }]);
    fireEvent.click(within(last.parent).getByRole('button', { name: 'Revert change' }));
    expect(last.editorView.state.doc.toString()).toBe('Before\nRemoved last');
  });

  it.each(['Accept change', 'Revert change'])('shows addition actions on any added line and handles %s', (action) => {
    const { editorView, markdownView, parent } = createEditor('Before\nAdded first\nAdded second\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    parent.classList.add('markdown-source-view', 'mod-cm6');
    const style = document.createElement('style');
    style.textContent = readFileSync('src/style/features/ai-edit-highlights.css', 'utf8');
    parent.appendChild(style);
    controller.recordDiffs([{
      filePath: 'notes/test.md',
      diffLines: [
        { type: 'equal', text: 'Before', oldLineNum: 1, newLineNum: 1 },
        { type: 'insert', text: 'Added first', newLineNum: 2 },
        { type: 'insert', text: 'Added second', newLineNum: 3 },
        { type: 'equal', text: 'After', oldLineNum: 2, newLineNum: 4 },
      ],
      stats: { added: 2, removed: 0 },
    }]);
    const toolbar = within(parent).getByRole('toolbar', { name: 'AI change actions' });
    expect(toolbar.closest('.cm-line')?.textContent).toContain('Added second');
    expect(getComputedStyle(toolbar).opacity).toBe('0');
    const lines = parent.querySelectorAll('.claudian-ai-edit-highlight');
    fireEvent.mouseOver(lines[0]);
    expect(getComputedStyle(toolbar).opacity).toBe('1');
    fireEvent.mouseOut(lines[0], { relatedTarget: parent });
    expect(getComputedStyle(toolbar).opacity).toBe('0');
    fireEvent.mouseOver(lines[0]);
    fireEvent.mouseOut(lines[0], { relatedTarget: lines[1] });
    fireEvent.mouseOver(lines[1]);
    expect(getComputedStyle(toolbar).opacity).toBe('1');
    const button = within(toolbar).getByRole('button', { name: action });
    fireEvent.mouseOut(lines[1], { relatedTarget: button });
    fireEvent.mouseOver(button);
    expect(getComputedStyle(toolbar).opacity).toBe('1');
    fireEvent.click(button);
    expect(editorView.state.doc.toString()).toBe(action === 'Accept change'
      ? 'Before\nAdded first\nAdded second\nAfter'
      : 'Before\nAfter');
    expect(within(parent).queryByRole('toolbar')).toBeNull();
  });

  it('shows inline controls when hovering a single added sentence', () => {
    const { editorView, markdownView, parent } = createEditor('Before\nAdded value\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    parent.classList.add('markdown-source-view', 'mod-cm6');
    const style = document.createElement('style');
    style.textContent = readFileSync('src/style/features/ai-edit-highlights.css', 'utf8');
    parent.appendChild(style);
    controller.recordDiffs([createAdditionDiff()]);
    const line = parent.querySelector('.claudian-ai-edit-highlight')!;
    fireEvent.mouseOver(line);
    const toolbar = within(line as HTMLElement).getByRole('toolbar');
    expect(getComputedStyle(toolbar).opacity).toBe('1');
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Accept change' }));
    expect(editorView.state.doc.toString()).toBe('Before\nAdded value\nAfter');
    expect(within(parent).queryByRole('toolbar')).toBeNull();
  });

  it('reverts an addition by removing the added lines', () => {
    const { editorView, markdownView, parent } = createEditor('Before\nAdded value\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([createAdditionDiff()]);

    fireEvent.click(within(parent).getByRole('button', { name: 'Revert change' }));

    expect(editorView.state.doc.toString()).toBe('Before\nAfter');
    expect(parent.querySelector('.claudian-ai-edit-review')).toBeNull();
  });

  it('keeps action buttons independent for multiple review blocks', () => {
    const { editorView, markdownView, parent } = createEditor(
      'Start\nFirst new\nMiddle\nSecond new\nEnd',
    );
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([{
      filePath: 'notes/test.md',
      diffLines: [
        { type: 'equal', text: 'Start', oldLineNum: 1, newLineNum: 1 },
        { type: 'delete', text: 'First old', oldLineNum: 2 },
        { type: 'insert', text: 'First new', newLineNum: 2 },
        { type: 'equal', text: 'Middle', oldLineNum: 3, newLineNum: 3 },
        { type: 'delete', text: 'Second old', oldLineNum: 4 },
        { type: 'insert', text: 'Second new', newLineNum: 4 },
        { type: 'equal', text: 'End', oldLineNum: 5, newLineNum: 5 },
      ],
      stats: { added: 2, removed: 2 },
    }]);

    const acceptButtons = within(parent).getAllByRole('button', { name: 'Accept change' });
    expect(acceptButtons).toHaveLength(2);
    fireEvent.click(acceptButtons[0]);

    expect(within(parent).getAllByRole('button', { name: 'Accept change' })).toHaveLength(1);
    expect(controller.hasHighlights()).toBe(true);
  });

  it('decorates a file when it is opened after the edit completed', () => {
    controller.recordDiffs([createDiff()]);
    const { editorView, markdownView, parent } = createEditor('Before\nNew value\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });

    controller.handleFileOpened(createTFile('notes/test.md'));

    expect(parent.querySelector('.claudian-ai-edit-highlight--modified')?.textContent)
      .toBe('New value');
  });

  it('does not retain paths outside the Vault', () => {
    controller.recordDiffs([createDiff('C:/outside/test.md')]);

    expect(controller.hasHighlights()).toBe(false);
  });

  it('clears stored and visible highlights together', () => {
    const { editorView, markdownView, parent } = createEditor('Before\nNew value\nAfter');
    editors.push(editorView);
    leaves.push({ view: markdownView });
    controller.recordDiffs([createDiff()]);

    controller.clearAll();

    expect(controller.hasHighlights()).toBe(false);
    expect(parent.querySelector('.claudian-ai-edit-highlight')).toBeNull();
  });

  it.each([
    [true, 'Revert change'],
    [false, 'Revert change'],
    [true, 'Accept change'],
  ] as const)('reviews a delayed deletion once with coordinates %s and action %s', (hasCoordinates, action) => {
    jest.useFakeTimers();
    try {
      const original = '# Test\n\nParagraph\n\n## Section\n\n123\n\n\n';
      const updated = '# Test\n\nParagraph\n\n## Section\n\n\n\n';
      const { editorView, markdownView, parent } = createEditor(original);
      editors.push(editorView);
      leaves.push({ view: markdownView });
      controller.beginOpenEditorCapture('patch-1');
      controller.completeOpenEditorCapture('patch-1', true);
      controller.recordDiffs([{
        filePath: 'notes/test.md',
        diffLines: [{ type: 'delete', text: '123', oldLineNum: hasCoordinates ? 7 : 1 }],
        lineNumbersAreDocumentRelative: hasCoordinates,
        stats: { added: 0, removed: 1 },
      }]);
      expect(within(parent).queryByRole('button', { name: 'Revert change' })).toBeNull();
      jest.advanceTimersByTime(600);
      editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: updated } });
      jest.runAllTimers();
      const review = within(parent).getByRole('region', { name: 'Deleted AI change review' });
      expect(review.textContent).toContain('123');
      expect(within(parent).getAllByRole('button', { name: 'Accept change' })).toHaveLength(1);
      fireEvent.click(within(review).getByRole('button', { name: action }));
      expect(editorView.state.doc.toString()).toBe(action === 'Revert change' ? original : updated);
      expect(within(parent).queryByRole('button', { name: 'Revert change' })).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains the provider diff when a capture starts after the editor has reloaded', () => {
    jest.useFakeTimers();
    try {
      const { editorView, markdownView, parent } = createEditor('Before\nAfter');
      editors.push(editorView);
      leaves.push({ view: markdownView });
      controller.beginOpenEditorCapture('patch-1');
      controller.completeOpenEditorCapture('patch-1', true);
      controller.recordDiffs([createDeletionDiff()]);
      jest.runAllTimers();
      fireEvent.click(within(parent).getByRole('button', { name: 'Revert change' }));
      expect(editorView.state.doc.toString()).toBe('Before\nRemoved value\nAfter');
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a turn fallback from recreating an already accepted tool edit', () => {
    jest.useFakeTimers();
    try {
      const { editorView, markdownView, parent } = createEditor('Before\nAfter');
      editors.push(editorView);
      leaves.push({ view: markdownView });
      controller.beginOpenEditorCapture('turn-1', true);
      controller.beginOpenEditorCapture('tool-1');
      editorView.dispatch({ changes: { from: 7, insert: 'Added value\n' } });
      controller.completeOpenEditorCapture('tool-1', true);
      jest.runAllTimers();
      fireEvent.click(within(parent).getByRole('button', { name: 'Accept change' }));
      controller.completeOpenEditorCapture('turn-1', true);
      jest.runAllTimers();
      expect(within(parent).queryByRole('button', { name: 'Accept change' })).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('creates a modified review from an AI shell-command editor snapshot', () => {
    jest.useFakeTimers();
    try {
      const { editorView, markdownView, parent } = createEditor('Before\nOld value\nAfter');
      editors.push(editorView);
      leaves.push({ view: markdownView });
      controller.beginOpenEditorCapture('shell-1');
      const changedLine = editorView.state.doc.line(2);
      editorView.dispatch({
        changes: { from: changedLine.from, to: changedLine.to, insert: 'New value' },
      });

      controller.completeOpenEditorCapture('shell-1', true);
      jest.runAllTimers();

      const review = parent.querySelector<HTMLElement>('.claudian-ai-edit-review--modified')!;
      expect(review.textContent).toContain('Old value');
      expect(within(review).getByRole('button', { name: 'Accept change' })).toBeDefined();
      expect(parent.querySelector('.claudian-ai-edit-highlight--modified')?.textContent)
        .toBe('New value');
    } finally {
      jest.useRealTimers();
    }
  });

  it('creates a deleted review from an AI shell-command editor snapshot', () => {
    jest.useFakeTimers();
    try {
      const { editorView, markdownView, parent } = createEditor('Before\nRemoved value\nAfter');
      editors.push(editorView);
      leaves.push({ view: markdownView });
      controller.beginOpenEditorCapture('shell-1');
      const removedLine = editorView.state.doc.line(2);
      editorView.dispatch({
        changes: { from: removedLine.from, to: editorView.state.doc.line(3).from, insert: '' },
      });

      controller.completeOpenEditorCapture('shell-1', true);
      jest.runAllTimers();

      const review = parent.querySelector<HTMLElement>('.claudian-ai-edit-review--deleted')!;
      expect(review.textContent).toContain('Removed value');
      expect(within(review).getByRole('button', { name: 'Revert change' })).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reviews partial writes even when the AI shell command fails', () => {
    jest.useFakeTimers();
    try {
      const { editorView, markdownView, parent } = createEditor('Before\nOld value\nAfter');
      editors.push(editorView);
      leaves.push({ view: markdownView });
      controller.beginOpenEditorCapture('shell-1');
      const changedLine = editorView.state.doc.line(2);
      editorView.dispatch({
        changes: { from: changedLine.from, to: changedLine.to, insert: 'Manual value' },
      });

      controller.completeOpenEditorCapture('shell-1', false);
      jest.runAllTimers();

      expect(within(parent).getByText('Old value')).toBeDefined();
      expect(controller.hasHighlights()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
