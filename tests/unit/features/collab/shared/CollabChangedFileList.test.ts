/** @jest-environment jsdom */

import type { CollabChangedFile } from '@claudian/collab-protocol';

import { renderCollabChangedFileList } from '@/features/collab/shared/CollabChangedFileList';

const FILES: readonly CollabChangedFile[] = [{
  binary: false,
  kind: 'deleted',
  largeForReview: false,
  path: 'notes/first.md',
}, {
  binary: false,
  kind: 'added',
  largeForReview: false,
  path: 'notes/second.md',
}];

describe('renderCollabChangedFileList', () => {
  beforeEach(() => document.body.replaceChildren());

  it('renders Personal files as an accessible list and refocuses selection', () => {
    const host = document.body.createDiv();
    const onSelect = jest.fn();

    const list = renderCollabChangedFileList({
      accessibleLabel: '2 changed files',
      container: host,
      files: FILES,
      focusOnSelect: true,
      onSelect,
      selectedPath: FILES[0].path,
      semantics: 'list',
    });

    expect(list.tagName).toBe('UL');
    expect(list.classList).toContain('claudian-collab-file-list');
    expect(list.classList).toContain('claudian-collab-file-list--list');
    expect(list.getAttribute('aria-label')).toBe('2 changed files');
    expect(list.children).toHaveLength(2);
    expect([...list.children].every(child => child.tagName === 'LI')).toBe(true);

    const buttons = list.querySelectorAll<HTMLButtonElement>(
      ':scope > li > .claudian-collab-file-button',
    );
    expect([...buttons].map(button => button.dataset.path)).toEqual([
      'notes/first.md',
      'notes/second.md',
    ]);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false');
    expect(buttons[0].querySelector('.claudian-collab-file-kind')?.textContent).toBe('D');
    expect(buttons[0].querySelector('.claudian-collab-file-kind')?.getAttribute('data-kind'))
      .toBe('deleted');
    expect(buttons[1].querySelector('.claudian-collab-file-kind')?.textContent).toBe('A');

    buttons[1].click();

    expect(onSelect).toHaveBeenCalledWith('notes/second.md');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('renders Team files as flat buttons without forcing focus', () => {
    const host = document.body.createDiv();
    const existingFocus = document.body.createEl('button');
    const onSelect = jest.fn();
    existingFocus.focus();

    const list = renderCollabChangedFileList({
      accessibleLabel: '2 changed files',
      container: host,
      files: FILES,
      focusOnSelect: false,
      onSelect,
      selectedPath: FILES[0].path,
      semantics: 'flat',
    });

    expect(list.tagName).toBe('DIV');
    expect(list.classList).toContain('claudian-collab-file-list--flat');
    expect(list.getAttribute('aria-label')).toBe('2 changed files');
    expect(list.querySelector('li')).toBeNull();
    const buttons = list.querySelectorAll<HTMLButtonElement>(
      ':scope > .claudian-collab-file-button',
    );
    expect(buttons).toHaveLength(2);

    buttons[1].click();

    expect(onSelect).toHaveBeenCalledWith('notes/second.md');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(existingFocus);
  });

  it('preserves every changed-file status code in input order', () => {
    const kinds = [
      'added',
      'modified',
      'deleted',
      'renamed',
      'copied',
      'type-changed',
    ] as const;

    const list = renderCollabChangedFileList({
      accessibleLabel: 'All change kinds',
      container: document.body,
      files: kinds.map(kind => ({
        binary: false,
        kind,
        largeForReview: false,
        path: `${kind}.md`,
      })),
      focusOnSelect: false,
      onSelect: jest.fn(),
      semantics: 'flat',
    });

    expect([...list.querySelectorAll<HTMLElement>('.claudian-collab-file-kind')]
      .map(element => [element.dataset.kind, element.textContent]))
      .toEqual([
        ['added', 'A'],
        ['modified', 'M'],
        ['deleted', 'D'],
        ['renamed', 'R'],
        ['copied', 'C'],
        ['type-changed', 'T'],
      ]);
  });
});
