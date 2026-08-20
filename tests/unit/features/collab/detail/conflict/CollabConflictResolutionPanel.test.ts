/** @jest-environment jsdom */

import type {
  CollabConflictFileContent,
  CollabConflictSession,
} from '@/core/collab';
import {
  type CollabConflictDiffPort,
  CollabConflictResolutionPanel,
  type CollabConflictResolutionPort,
} from '@/features/collab/detail/conflict/CollabConflictResolutionPanel';

const PERSONAL = '1'.repeat(40);
const MAIN = '2'.repeat(40);
const BASE = '3'.repeat(40);

describe('CollabConflictResolutionPanel', () => {
  it('renders an existing Request conflict as immutable evidence without resolution controls', async () => {
    const fixture = createFixture('request');

    await fixture.panel.open('operation-a');

    expect(fixture.root.dataset.conflictLocation).toBe('request');
    expect(fixture.root.textContent).toContain('Request conflict');
    expect(fixture.root.textContent).toContain('6 conflicted files');
    expect(fixture.root.textContent).toContain('Edit the project files, then publish again');
    expect(fixture.root.textContent).toContain('Mine');
    expect(fixture.root.textContent).toContain('Accepted version');
    expect(fixture.root.textContent).not.toMatch(/HEAD|index|refs\/|stage 2/i);
    expect(fixture.root.querySelector('[data-conflict-choice]')).toBeNull();
    expect(fixture.root.querySelector('[data-conflict-action="finalize"]')).toBeNull();
    expect(fixture.root.querySelector('[data-conflict-editor]')).toBeNull();
    expect(fixture.root.querySelectorAll('[data-conflict-path]')).toHaveLength(6);
    expect(fixture.comparisonDiffs).toHaveLength(1);
    expect(fixture.comparisonDiffs[0]?.render).toHaveBeenCalledWith({
      container: expect.any(HTMLElement),
      layout: 'split',
      newText: 'before\nmine one\nmiddle\nmine two\nafter\n',
      oldText: 'accepted\n',
      path: 'note.md',
    });
  });

  it('distinguishes an unpublished My changes conflict', async () => {
    const fixture = createFixture('my-changes');

    await fixture.panel.open('operation-a');

    expect(fixture.root.dataset.conflictLocation).toBe('my-changes');
    expect(fixture.root.textContent).toContain('My changes conflict');
  });

  it.each([
    ['image.png', 'Binary file'],
    ['removed.md', 'Deleted on one side'],
    ['old-name.md', 'Renamed on one side'],
  ] as const)('shows both immutable sides for %s', async (path, label) => {
    const fixture = createFixture();

    await fixture.panel.open('operation-a');

    const section = conflictSection(fixture.root, path);
    expect(section.textContent).toContain(label);
    expect(section.textContent).toContain('Accepted version');
    expect(section.textContent).toContain('Mine');
    expect(section.querySelector('button')).toBeNull();
  });

  it.each([
    ['Readme.md', 'Filename collision'],
    ['docs', 'File and folder collision'],
  ] as const)('keeps blocking conflict %s readable without offering an automatic choice', async (
    path,
    label,
  ) => {
    const fixture = createFixture();

    await fixture.panel.open('operation-a');

    const section = conflictSection(fixture.root, path);
    expect(section.textContent).toContain(label);
    expect(section.textContent).toContain('cannot be resolved automatically');
    expect(section.querySelector('button')).toBeNull();
  });

  it('offers only a read retry when loading the durable conflict fails', async () => {
    const fixture = createFixture();
    fixture.port.readConflict.mockResolvedValueOnce({
      error: { code: 'operation-failed' } as never,
      status: 'failure',
    });

    await fixture.panel.open('operation-a');

    expect(fixture.root.textContent).toContain('These conflicts could not be loaded');
    const reload = fixture.root.querySelector<HTMLButtonElement>(
      '[data-conflict-action="reload"]',
    );
    expect(reload).not.toBeNull();
    reload?.click();
    await nextTurn();
    expect(fixture.port.readConflict).toHaveBeenCalledTimes(2);
  });

  it('releases every diff renderer on destroy', async () => {
    const fixture = createFixture();
    await fixture.panel.open('operation-a');

    fixture.panel.destroy();

    expect(fixture.comparisonDiffs[0]?.destroy).toHaveBeenCalledTimes(1);
  });
});

function createFixture(location: 'my-changes' | 'request' = 'my-changes') {
  const root = document.createElement('div');
  document.body.append(root);
  const content = conflictContents();
  const port = {
    readConflict: jest.fn(async () => ({
      status: 'success' as const,
      value: defaultSession(),
    })),
    readConflictFile: jest.fn(async ({ path }: { path: string }) => ({
      status: 'success' as const,
      value: content.get(path)!,
    })),
  } as unknown as jest.Mocked<CollabConflictResolutionPort>;
  const comparisonDiffs: Array<jest.Mocked<CollabConflictDiffPort>> = [];
  const panel = new CollabConflictResolutionPanel(root, port, {
    comparisonDiffFactory: () => {
      const diff = conflictDiff();
      comparisonDiffs.push(diff);
      return diff;
    },
    location,
  });
  return { comparisonDiffs, panel, port, root };
}

function conflictContents(): Map<string, CollabConflictFileContent> {
  return new Map<string, CollabConflictFileContent>([
    ['note.md', {
      accepted: { path: 'note.md', text: 'accepted\n' },
      base: { path: 'note.md', text: 'base\n' },
      kind: 'text' as const,
      path: 'note.md',
      personal: { path: 'note.md', text: 'before\nmine one\nmiddle\nmine two\nafter\n' },
      segments: [
        { kind: 'common' as const, text: 'before\n' },
        {
          accepted: 'accepted one\n',
          base: 'base one\n',
          id: 'hunk-1',
          kind: 'conflict' as const,
          personal: 'mine one\n',
        },
        { kind: 'common' as const, text: 'middle\n' },
        {
          accepted: 'accepted two\n',
          base: 'base two\n',
          id: 'hunk-2',
          kind: 'conflict' as const,
          personal: 'mine two\n',
        },
        { kind: 'common' as const, text: 'after\n' },
      ],
    }],
    ['image.png', opaque('binary', 'image.png', true, true)],
    ['removed.md', opaque('delete-modify', 'removed.md', false, true)],
    ['old-name.md', {
      ...opaque('rename-delete', 'old-name.md', true, false),
      personal: { bytes: 8, exists: true, path: 'new-name.md' },
    }],
    ['Readme.md', { kind: 'portability' as const, path: 'Readme.md' }],
    ['docs', { kind: 'directory-file' as const, path: 'docs' }],
  ]);
}

function defaultSession(): CollabConflictSession {
  const conflicts: CollabConflictSession['descriptor']['conflicts'] = [
    { kind: 'text', path: 'note.md' },
    { kind: 'binary', path: 'image.png' },
    { kind: 'delete-modify', path: 'removed.md' },
    {
      acceptedPath: 'old-name.md',
      kind: 'rename-delete',
      path: 'old-name.md',
      personalPath: 'new-name.md',
    },
    { kind: 'portability', path: 'Readme.md' },
    { kind: 'directory-file', path: 'docs' },
  ];
  return {
    descriptor: {
      conflicts,
      mergeBaseOid: BASE,
      operationId: 'operation-a',
      projectId: 'project-a',
      startingMainOid: MAIN,
      startingPersonalOid: PERSONAL,
    },
  };
}

function conflictDiff(): jest.Mocked<CollabConflictDiffPort> {
  return {
    clear: jest.fn(),
    destroy: jest.fn(),
    render: jest.fn().mockResolvedValue(undefined),
  };
}

function opaque(
  kind: 'binary' | 'delete-modify' | 'rename-delete',
  path: string,
  personalExists: boolean,
  acceptedExists: boolean,
): Extract<CollabConflictFileContent, { personal: { exists: boolean } }> {
  return {
    accepted: { bytes: acceptedExists ? 7 : 0, exists: acceptedExists, path },
    base: { bytes: 6, exists: true, path },
    kind,
    path,
    personal: { bytes: personalExists ? 8 : 0, exists: personalExists, path },
  };
}

function conflictSection(root: HTMLElement, path: string): HTMLElement {
  const element = [...root.querySelectorAll<HTMLElement>('[data-conflict-path]')]
    .find(candidate => candidate.dataset.conflictPath === path);
  if (!element) throw new Error(`Missing conflict section: ${path}`);
  return element;
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
