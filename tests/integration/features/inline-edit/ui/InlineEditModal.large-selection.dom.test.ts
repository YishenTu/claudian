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
  const lines = Array.from({ length: 10_000 }, (_, index) => `Paragraph ${index}: retain this note text.\n`);
  const before = lines.join('');
  lines[5_000] = 'Paragraph 5000: clarified note text.\n';
  const after = lines.join('');
  h.editorView.dispatch({ changes: { from: 0, to: h.editorView.state.doc.length, insert: before } });
  const lastLine = h.editorView.state.doc.line(h.editorView.state.doc.lines);
  h.editor.getSelection = () => before;
  h.editor.getCursor = (which: string) => which === 'from'
    ? { line: 0, ch: 0 } : { line: lastLine.number - 1, ch: lastLine.length };
  h.editor.replaceRange = (text: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => {
    const doc = h.editorView.state.doc;
    h.editorView.dispatch({ changes: {
      from: doc.line(from.line + 1).from + from.ch,
      to: doc.line(to.line + 1).from + to.ch,
      insert: text,
    } });
  };
  // Only Obsidian rendering is adapted; actual selection, provider response,
  // line diff, Markdown document reconstruction and acceptance run unchanged.
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
  expect(h.editorView.state.doc.toString()).toBe(after);
  expect(h.settled).toHaveBeenCalledWith({ decision: 'accept', editedText: after });
}, 20_000);
