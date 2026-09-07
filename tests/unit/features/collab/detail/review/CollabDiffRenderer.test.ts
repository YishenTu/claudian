/** @jest-environment jsdom */

import { getOriginalDoc } from '@codemirror/merge';
import { EditorView } from '@codemirror/view';
import { fireEvent, getAllByRole, getByRole, queryByRole } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import {
  CollabDiffRenderer,
  type CollabDiffThemeSource,
} from '@/features/collab/detail/review/CollabDiffRenderer';

describe('CollabDiffRenderer', () => {
  let container: HTMLElement;
  let renderer: CollabDiffRenderer;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    renderer = new CollabDiffRenderer({ themeSource: themes('light') });
  });

  afterEach(() => {
    renderer.destroy();
    document.body.replaceChildren();
  });

  it('shows read-only plain-text evidence with a file-scoped open action', async () => {
    const opened: string[] = [];
    await renderer.render({
      container,
      newText: '<img src=x onerror=alert(1)>\nnew\n',
      oldText: 'old\n',
      onOpenFile: () => opened.push('note.md'),
      path: 'note.md',
    });

    const content = getByRole(container, 'textbox', { name: 'note.md' });
    expect(content.getAttribute('contenteditable')).toBe('false');
    expect(EditorView.findFromDOM(content)?.state.doc.toString()).toBe(
      '<img src=x onerror=alert(1)>\nnew\n',
    );
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(getByRole(container, 'button', { name: 'Open this file' }));
    expect(opened).toEqual(['note.md']);
    expect(await axe(container)).toHaveNoViolations();
  });
  it('supports keyboard selection without editing the reviewed text', async () => {
    await renderer.render({ container, oldText: 'old', newText: 'new', path: 'note.md' });
    const content = getByRole(container, 'textbox');
    const editor = EditorView.findFromDOM(content)!;
    content.focus();
    fireEvent.keyDown(content, { key: 'ArrowRight', shiftKey: true });
    expect(editor.state.selection.main.from).toBe(0);
    expect(editor.state.selection.main.to).toBe(1);
    fireEvent.keyDown(content, { key: 'Backspace' });
    expect(editor.state.doc.toString()).toBe('new');
  });

  it('switches split and unified layouts while keeping both reviewed snapshots', async () => {
    await renderer.render({ container, layout: 'split', oldText: 'before\n', newText: 'after\n', path: 'new.md', previousPath: 'old.md' });
    expect(EditorView.findFromDOM(getByRole(container, 'textbox', { name: 'old.md' }))?.state.doc.toString()).toBe('before\n');
    expect(EditorView.findFromDOM(getByRole(container, 'textbox', { name: 'new.md' }))?.state.doc.toString()).toBe('after\n');
    renderer.setLayout('unified');
    const unified = EditorView.findFromDOM(getByRole(container, 'textbox', { name: 'new.md' }))!;
    expect(getAllByRole(container, 'textbox')).toHaveLength(1);
    expect(getOriginalDoc(unified.state).toString()).toBe('before\n');
    expect(unified.state.doc.toString()).toBe('after\n');
    expect(queryByRole(container, 'button')).toBeNull();
    renderer.setLayout('split');
    expect(getAllByRole(container, 'textbox')).toHaveLength(2);
  });

  it('preserves the selection when identical evidence moves to a new wrapper', async () => {
    const input = { container, oldText: 'old', newText: 'new', path: 'note.md' };
    await renderer.render(input);
    const content = getByRole(container, 'textbox');
    const editor = EditorView.findFromDOM(content)!;
    editor.dispatch({ selection: { anchor: 1, head: 3 } });
    const next = document.createElement('div');
    document.body.appendChild(next);
    await renderer.render({ ...input, container: next });
    expect(queryByRole(container, 'textbox')).toBeNull();
    expect(getByRole(next, 'textbox')).toBe(content);
    expect(editor.state.selection.main.from).toBe(1);
    expect(editor.state.selection.main.to).toBe(3);
  });

  it.each([
    [null, '', 'Added'],
    ['', null, 'Deleted'],
    ['before\r\n', 'after\r\n', ''],
    ['line\n', 'line', ''],
  ])('preserves empty files and exact line endings (%p, %p)', async (oldText, newText, status) => {
    await renderer.render({ container, oldText, newText, path: 'note.md' });
    const editor = EditorView.findFromDOM(getByRole(container, 'textbox'))!;
    expect(editor.state.doc.toString()).toBe(newText ?? '');
    expect(getOriginalDoc(editor.state).toString()).toBe(oldText ?? '');
    expect(container.textContent).toContain(status);
  });

  it('lets keyboard users expand collapsed unchanged evidence', async () => {
    const unchanged = Array.from({ length: 30 }, (_, index) => `context ${index}\n`).join('');
    await renderer.render({ container, oldText: unchanged + 'old\n', newText: unchanged + 'new\n', path: 'note.md' });
    const expand = getByRole(container, 'button', { name: /unchanged lines/ });
    expect(expand.tabIndex).toBe(0);
    expand.focus();
    fireEvent.keyDown(expand, { key: 'Enter' });
    expect(document.activeElement).toBe(getByRole(container, 'textbox'));
    expect(queryByRole(container, 'button', { name: /unchanged lines/ })).toBeNull();
    expect(container.textContent).toContain('context 0');
  });

  it('reconfigures theme without replacing evidence or selection and releases it on clear', async () => {
    const source = themes('light');
    renderer.destroy();
    renderer = new CollabDiffRenderer({ themeSource: source });
    await renderer.render({ container, oldText: 'old', newText: 'new', path: 'note.md' });
    const content = getByRole(container, 'textbox');
    const editor = EditorView.findFromDOM(content)!;
    editor.dispatch({ selection: { anchor: 1 } });
    source.set('dark');
    expect(editor.state.facet(EditorView.darkTheme)).toBe(true);
    expect(getByRole(container, 'textbox')).toBe(content);
    expect(editor.state.selection.main.anchor).toBe(1);
    renderer.clear();
    expect(queryByRole(container, 'textbox')).toBeNull();
    source.set('light');
  });

  it('rejects malformed and over-limit evidence before creating an editor', async () => {
    const input = { container, oldText: 'old', newText: 'new', path: 'note.md' };
    await expect(renderer.render({ ...input, oldText: null, newText: null })).rejects.toMatchObject({ code: 'operation-failed' });
    await expect(renderer.render({ ...input, newText: 'x'.repeat(CLAUDIAN_COLLAB_LIMITS.maxTextDiffBytes + 1) })).rejects.toMatchObject({ code: 'quota-exceeded' });
    await expect(renderer.render({ ...input, newText: '\n'.repeat(CLAUDIAN_COLLAB_LIMITS.maxTextDiffLines) })).rejects.toMatchObject({ code: 'quota-exceeded' });
    expect(queryByRole(container, 'textbox')).toBeNull();
  });

  it.each(['clear', 'destroy'] as const)('fences pending module completion after %s', async action => {
    const module = await import('@/features/collab/detail/review/CollabCodeMirrorDiffModule');
    let complete!: (value: typeof module) => void;
    renderer.destroy();
    renderer = new CollabDiffRenderer({
      loadDiffs: () => new Promise(resolve => { complete = resolve; }),
      themeSource: themes('light'),
    });
    const pending = renderer.render({ container, oldText: 'old', newText: 'new', path: 'note.md' });
    renderer[action]();
    complete(module);
    await pending;
    expect(queryByRole(container, 'textbox')).toBeNull();
  });

  it('renders only the latest pending file and retries a failed lazy load', async () => {
    const module = await import('@/features/collab/detail/review/CollabCodeMirrorDiffModule');
    let fail = true;
    let complete!: (value: typeof module) => void;
    renderer.destroy();
    renderer = new CollabDiffRenderer({
      loadDiffs: () => {
        if (fail) { fail = false; return Promise.reject(new Error('load failed')); }
        return new Promise(resolve => { complete = resolve; });
      },
      themeSource: themes('light'),
    });
    const input = { container, oldText: 'old', newText: 'new', path: 'first.md' };
    await expect(renderer.render(input)).rejects.toThrow('load failed');
    const first = renderer.render(input);
    const second = renderer.render({ ...input, path: 'second.md' });
    complete(module);
    await Promise.all([first, second]);
    expect(queryByRole(container, 'textbox', { name: 'first.md' })).toBeNull();
    expect(getByRole(container, 'textbox', { name: 'second.md' })).toBeDefined();
  });

});

function themes(initial: 'dark' | 'light') {
  let current = initial;
  const listeners = new Set<(theme: 'dark' | 'light') => void>();
  return {
    current: () => current,
    set(theme: 'dark' | 'light') {
      current = theme;
      for (const listener of listeners) listener(theme);
    },
    subscribe(listener: (theme: 'dark' | 'light') => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } satisfies CollabDiffThemeSource & { set(theme: 'dark' | 'light'): void };
}
