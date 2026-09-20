/**
 * @jest-environment jsdom
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { hideSelectionHighlight, showSelectionHighlight } from '@/shared/components/SelectionHighlight';

function createEditorView(doc = 'hello world'): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  return new EditorView({ state: EditorState.create({ doc }), parent });
}

function highlightCount(editorView: EditorView): number {
  return editorView.dom.querySelectorAll('.claudian-selection-highlight').length;
}

describe('SelectionHighlight', () => {
  let editorView: EditorView;

  afterEach(() => {
    editorView.destroy();
    document.body.replaceChildren();
  });

  it('marks the requested range and clears it again', () => {
    editorView = createEditorView();

    showSelectionHighlight(editorView, 0, 5);
    expect(highlightCount(editorView)).toBe(1);

    hideSelectionHighlight(editorView);
    expect(highlightCount(editorView)).toBe(0);
  });

  it('marks the range again after the editor state is replaced', () => {
    editorView = createEditorView();
    showSelectionHighlight(editorView, 0, 5);

    // Obsidian reuses one EditorView per leaf and swaps in a fresh state when
    // another note is opened, which drops previously appended configuration.
    editorView.setState(EditorState.create({ doc: 'second note' }));

    showSelectionHighlight(editorView, 0, 6);
    expect(highlightCount(editorView)).toBe(1);
  });
});
