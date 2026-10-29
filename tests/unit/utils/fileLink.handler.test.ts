/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Keymap, Notice } from 'obsidian';

import { registerFileLinkHandler } from '@/utils/fileLink';

function pendingOperation() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Let detached async continuations and host rejection delivery run before absence checks.
async function nextTurn() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.mocked(Notice).mockClear();
});

describe('registerFileLinkHandler', () => {
  it.each([
    ['data-href="note#section" href="note"', 'note#section'],
    ['href="note^block"', 'note^block'],
  ])('opens the delegated target and removes the handler: %s', async (attributes, expectedTarget) => {
    const app = {
      metadataCache: { getFirstLinkpathDest: vi.fn().mockReturnValue(null) },
      workspace: { openLinkText: vi.fn().mockResolvedValue(undefined) },
    };
    const container = document.createElement('div');
    container.innerHTML = `<a class="internal-link" ${attributes}><span>Note</span></a>`;
    document.body.appendChild(container);
    const link = within(container).getByRole('link', { name: 'Note' });
    const cleanup = registerFileLinkHandler(app as any, container);
    try {
      expect(fireEvent.click(link.firstElementChild!)).toBe(false);
      expect(app.workspace.openLinkText).toHaveBeenCalledWith(expectedTarget, '', 'tab');
      await nextTurn();
      expect(Notice).not.toHaveBeenCalled();
      cleanup();
      // Prevent jsdom navigation after the application handler has been removed.
      link.addEventListener('click', (event) => event.preventDefault(), { once: true });
      fireEvent.click(link);
      await nextTurn();
      expect(app.workspace.openLinkText).toHaveBeenCalledTimes(1);
      expect(Notice).not.toHaveBeenCalled();
    } finally {
      cleanup();
      container.remove();
    }
  });

  it.each([
    ['open', false],
    ['open', true],
    ['reveal', false],
    ['reveal', true],
  ] as const)('reports a failed %s once and allows retry (pending: %s)', async (operation, delayed) => {
    const failure = new Error('PRIVATE_WORKSPACE_PATH:/private/vault/secret.md');
    const pending = pendingOperation();
    const fail = () => delayed ? pending.promise : Promise.reject(failure);
    const existingLeaf = {
      getViewState: () => ({ type: 'markdown', state: { file: 'Notes/Plan.md' } }),
      setEphemeralState: vi.fn(),
    };
    const otherLeaf = {
      getViewState: () => ({ type: 'markdown', state: { file: 'Archive/Plan.md' } }),
    };
    const app = {
      metadataCache: {
        getFirstLinkpathDest: vi.fn().mockReturnValue(operation === 'reveal' ? { path: 'Notes/Plan.md' } : null),
      },
      workspace: {
        iterateAllLeaves: (visit: (leaf: unknown) => void) => [otherLeaf, existingLeaf].forEach(visit),
        openLinkText: vi.fn().mockResolvedValue(undefined),
        revealLeaf: vi.fn().mockResolvedValue(undefined),
      },
    };
    const activate = operation === 'open' ? app.workspace.openLinkText : app.workspace.revealLeaf;
    activate.mockImplementationOnce(fail);
    const container = document.createElement('div');
    container.innerHTML = '<a class="claudian-file-link" href="Notes/Plan.md" data-href="Notes/Plan.md#Heading"><span>Plan</span></a>';
    document.body.appendChild(container);
    const link = within(container).getByRole('link', { name: 'Plan' });
    const cleanup = registerFileLinkHandler(app as any, container);
    try {
      expect(fireEvent.click(link.firstElementChild!)).toBe(false);
      expect(activate).toHaveBeenCalledTimes(1);
      expect(app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith('Notes/Plan.md', '');
      expect(activate.mock.calls).toEqual([
        operation === 'open' ? ['Notes/Plan.md#Heading', '', 'tab'] : [existingLeaf],
      ]);
      await nextTurn();
      expect(Notice).toHaveBeenCalledTimes(delayed ? 0 : 1);
      expect(existingLeaf.setEphemeralState).not.toHaveBeenCalled();
      if (delayed) {
        pending.reject(failure);
      }
      await waitFor(() => expect(Notice).toHaveBeenCalledTimes(1));
      await nextTurn();
      expect(vi.mocked(Notice).mock.calls).toEqual([['Failed to open file.']]);
      expect(existingLeaf.setEphemeralState).not.toHaveBeenCalled();
      expect(app.workspace.openLinkText).toHaveBeenCalledTimes(operation === 'reveal' ? 0 : 1);

      const retry = pendingOperation();
      activate.mockImplementationOnce(() => retry.promise);
      expect(fireEvent.click(link.firstElementChild!)).toBe(false);
      expect(activate).toHaveBeenCalledTimes(2);
      retry.resolve();
      await nextTurn();
      expect(existingLeaf.setEphemeralState.mock.calls).toEqual(
        operation === 'reveal' ? [[{ focus: true, subpath: '#Heading' }]] : []
      );
      expect(app.workspace.openLinkText).toHaveBeenCalledTimes(operation === 'reveal' ? 0 : 2);
      expect(vi.mocked(Notice).mock.calls).toEqual([['Failed to open file.']]);
      cleanup();
      link.addEventListener('click', event => event.preventDefault(), { once: true });
      fireEvent.click(link.firstElementChild!);
      await nextTurn();
      expect(activate).toHaveBeenCalledTimes(2);
      expect(Notice).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      container.remove();
    }
  });

  it('keeps the connected file link accessible', async () => {
    const container = document.createElement('div');
    container.innerHTML = '<a class="internal-link" href="Notes/Plan.md"><span>Plan</span></a>';
    document.body.appendChild(container);
    try {
      expect(within(container).getByRole('link', { name: 'Plan' })).toBeInstanceOf(HTMLAnchorElement);
      expect((await axe(container)).violations).toEqual([]);
    } finally {
      container.remove();
    }
  });
});

it.each([
  ['claudian-file-link', '', false],
  ['internal-link', '', true],
  ['internal-link', '#Heading', false],
  ['claudian-file-link', '#^block', true],
] as const)('focuses the existing tab for %s with subpath %s (deferred: %s)', async (className, subpath, isDeferred) => {
  const reveal = pendingOperation();
  const existingLeaf = {
    isDeferred,
    getViewState: () => ({ type: 'markdown', state: { file: 'Notes/Plan.md' } }),
    setEphemeralState: vi.fn(),
  };
  const otherLeaf = {
    getViewState: () => ({ type: 'markdown', state: { file: 'Archive/Plan.md' } }),
  };
  const app = {
    metadataCache: { getFirstLinkpathDest: vi.fn().mockReturnValue({ path: 'Notes/Plan.md' }) },
    workspace: {
      iterateAllLeaves: (visit: (leaf: unknown) => void) => [otherLeaf, existingLeaf].forEach(visit),
      revealLeaf: vi.fn().mockReturnValue(reveal.promise),
      openLinkText: vi.fn(),
    },
  };
  const container = document.createElement('div');
  container.innerHTML = `<a class="${className}" href="Notes/Plan.md" data-href="Notes/Plan.md${subpath}">Plan</a>`;
  document.body.appendChild(container);
  const cleanup = registerFileLinkHandler(app as any, container);
  try {
    fireEvent.click(within(container).getByRole('link', { name: 'Plan' }));
    await nextTurn();
    expect(existingLeaf.setEphemeralState).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
    reveal.resolve();
    await waitFor(() => expect(existingLeaf.setEphemeralState).toHaveBeenCalledWith(subpath ? { focus: true, subpath } : { focus: true }));
    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(app.workspace.openLinkText).not.toHaveBeenCalled();
    await nextTurn();
    expect(Notice).not.toHaveBeenCalled();
  } finally {
    cleanup();
    container.remove();
  }
});


it.each([
  ['click', { ctrlKey: true }, 'tab'],
  ['click', { ctrlKey: true, altKey: true }, 'split'],
  ['click', { ctrlKey: true, altKey: true, shiftKey: true }, 'window'],
  ['auxclick', { button: 1 }, 'tab'],
] as const)('honors Obsidian pane intent for %s %j instead of revealing an existing note', async (eventType, init, pane) => {
  const leaf = { getViewState: () => ({ state: { file: 'Notes/Target.md' } }), setEphemeralState: vi.fn() };
  const app = {
    metadataCache: { getFirstLinkpathDest: vi.fn(() => ({ path: 'Notes/Target.md' })) },
    workspace: {
      iterateAllLeaves: (visit: (value: typeof leaf) => void) => visit(leaf),
      revealLeaf: vi.fn().mockResolvedValue(undefined), openLinkText: vi.fn().mockResolvedValue(undefined),
    },
  };
  const container = document.body.appendChild(document.createElement('div'));
  container.innerHTML = '<a class="claudian-file-link" href="Target#Heading">Target</a>';
  const link = within(container).getByRole('link', { name: 'Target' });
  const release = registerFileLinkHandler(app as any, container, 'Notes/Source.md');
  vi.mocked(Keymap.isModEvent).mockReturnValueOnce(pane);
  try {
    const event = new MouseEvent(eventType, { bubbles: true, cancelable: true, ...init });
    fireEvent(link, event);
    await nextTurn();
    expect(app.workspace.openLinkText).toHaveBeenCalledWith('Target#Heading', 'Notes/Source.md', pane);
    expect(app.workspace.openLinkText).toHaveBeenCalledTimes(1);
    expect(app.workspace.revealLeaf).not.toHaveBeenCalled();
    expect(leaf.setEphemeralState).not.toHaveBeenCalled();
    expect(Keymap.isModEvent).toHaveBeenCalledWith(event);
    expect(event.defaultPrevented).toBe(true);
    release();
    link.addEventListener(eventType, event => event.preventDefault());
    fireEvent(link, new MouseEvent(eventType, { bubbles: true, cancelable: true, ...init }));
    await nextTurn();
    expect(app.workspace.openLinkText).toHaveBeenCalledTimes(1);
  } finally {
    vi.mocked(Keymap.isModEvent).mockReset().mockReturnValue(false);
    release(); container.remove();
  }
});


it('leaves right-button auxiliary clicks to the native context menu', () => {
  const app = { metadataCache: { getFirstLinkpathDest: vi.fn(() => null) }, workspace: { openLinkText: vi.fn() } };
  const container = document.body.appendChild(document.createElement('div'));
  container.innerHTML = '<a class="internal-link" href="Target">Target</a>';
  const release = registerFileLinkHandler(app as any, container);
  try {
    expect(fireEvent(within(container).getByRole('link', { name: 'Target' }), new MouseEvent('auxclick', { button: 2, bubbles: true, cancelable: true }))).toBe(true);
    expect(app.workspace.openLinkText).not.toHaveBeenCalled();
    expect(app.metadataCache.getFirstLinkpathDest).not.toHaveBeenCalled();
  } finally { release(); container.remove(); }
});
