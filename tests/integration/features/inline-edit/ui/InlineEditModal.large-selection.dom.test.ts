/** @vitest-environment jsdom */

import {
  createInlineEditHarness,
  disposeInlineEditHarnesses,
  showReplacementPreview,
} from '@test/helpers/features/inline-edit/InlineEditDOMHarness';
import { fireEvent, screen, waitFor } from '@testing-library/dom';
import { MarkdownRenderer } from 'obsidian';

import { InlineEditSession } from '@/features/inline-edit/ui/InlineEditModal';

afterEach(async () => {
  await disposeInlineEditHarnesses();
  vi.mocked(MarkdownRenderer.render).mockReset();
});

it('previews and applies a one-line change to a 10,000-line selected note', async () => {
  const h = await createInlineEditHarness();
  // jsdom has no layout. Give CodeMirror a visible editor so it virtualizes the note after acceptance.
  const measure = HTMLElement.prototype.getBoundingClientRect;
  using geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
  geometry.mockImplementation(function (this: HTMLElement) {
    if (this === h.editorView.contentDOM) return DOMRect.fromRect({ width: 800, height: 600 });
    if (this.classList.contains('cm-line')) return DOMRect.fromRect({ width: 800, height: 20 });
    return measure.call(this);
  });
  const lines = Array.from({ length: 10_000 }, (_, index) => `Paragraph ${index}: retain this note text.\n`);
  const before = lines.join('');
  lines[5_000] = 'Paragraph 5000: clarified note text.\n';
  const after = lines.join('');
  h.editorView.dispatch({ changes: { from: 0, to: h.editorView.state.doc.length, insert: before } });
  const lastLine = h.editorView.state.doc.line(h.editorView.state.doc.lines);
  h.editor.getSelection = () => before;
  h.editor.getCursor = (which = 'head') => which === 'from'
    ? { line: 0, ch: 0 } : { line: lastLine.number - 1, ch: lastLine.length };
  h.editor.replaceRange = (text, from, to = from) => {
    const doc = h.editorView.state.doc;
    h.editorView.dispatch({ changes: {
      from: doc.line(from.line + 1).from + from.ch,
      to: doc.line(to.line + 1).from + to.ch,
      insert: text,
    } });
  };
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, target) => {
    target.textContent = markdown;
  });
  const session = new InlineEditSession(h.app, h.plugin, h.component, h.editorView, h.editor,
    { mode: 'selection', selectedText: before }, h.notePath, h.settled, { providerId: 'claude' });
  session.show();
  const accept = await showReplacementPreview(h, after);
  await waitFor(() => expect(vi.mocked(MarkdownRenderer.render).mock.calls.map(call => call[1])).toEqual([before, after]));
  expect(screen.getByRole('toolbar', { name: 'Inline edit actions' }).textContent).toContain('+1');
  expect(screen.getByRole('toolbar', { name: 'Inline edit actions' }).textContent).toContain('−1');
  expect(h.editorView.state.doc.toString()).toBe(before);
  fireEvent.click(accept);
  expect(h.editorView.viewport.to).toBeLessThan(h.editorView.state.doc.length);
  expect(h.editorView.state.doc.toString()).toBe(after);
  expect(h.settled).toHaveBeenCalledWith({ decision: 'accept', editedText: after });
}, 20_000);
