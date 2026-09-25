/** @jest-environment jsdom */

import { fireEvent, waitFor, within } from '@testing-library/dom';

import { registerFileLinkHandler } from '@/utils/fileLink';

describe('registerFileLinkHandler', () => {
  it.each([
    ['data-href="note#section" href="note"', 'note#section'],
    ['href="note^block"', 'note^block'],
  ])('opens the delegated target and removes the handler: %s', (attributes, expectedTarget) => {
    const app = {
      metadataCache: { getFirstLinkpathDest: jest.fn().mockReturnValue(null) },
      workspace: { openLinkText: jest.fn() },
    };
    const container = document.createElement('div');
    container.innerHTML = `<a class="internal-link" ${attributes}><span>Note</span></a>`;
    const link = within(container).getByRole('link', { name: 'Note' });
    const cleanup = registerFileLinkHandler(app as any, container);
    try {
      expect(fireEvent.click(link.firstElementChild!)).toBe(false);
      expect(app.workspace.openLinkText).toHaveBeenCalledWith(expectedTarget, '', 'tab');
      cleanup();
      // Prevent jsdom navigation after the application handler has been removed.
      link.addEventListener('click', (event) => event.preventDefault(), { once: true });
      fireEvent.click(link);
      expect(app.workspace.openLinkText).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});

it.each([
  ['claudian-file-link', '', false],
  ['internal-link', '', true],
  ['internal-link', '#Heading', false],
  ['claudian-file-link', '#^block', true],
] as const)('focuses the existing tab for %s with subpath %s (deferred: %s)', async (className, subpath, isDeferred) => {
  const existingLeaf = {
    isDeferred,
    getViewState: () => ({ type: 'markdown', state: { file: 'Notes/Plan.md' } }),
    setEphemeralState: jest.fn(),
  };
  const otherLeaf = {
    getViewState: () => ({ type: 'markdown', state: { file: 'Archive/Plan.md' } }),
  };
  const app = {
    metadataCache: { getFirstLinkpathDest: jest.fn().mockReturnValue({ path: 'Notes/Plan.md' }) },
    workspace: {
      iterateAllLeaves: (visit: (leaf: unknown) => void) => [otherLeaf, existingLeaf].forEach(visit),
      revealLeaf: jest.fn().mockResolvedValue(undefined),
      openLinkText: jest.fn(),
    },
  };
  const container = document.createElement('div');
  container.innerHTML = `<a class="${className}" href="Notes/Plan.md" data-href="Notes/Plan.md${subpath}">Plan</a>`;
  const cleanup = registerFileLinkHandler(app as any, container);
  try {
    fireEvent.click(within(container).getByRole('link', { name: 'Plan' }));
    await waitFor(() => expect(existingLeaf.setEphemeralState).toHaveBeenCalledWith(subpath ? { focus: true, subpath } : { focus: true }));
    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(app.workspace.openLinkText).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});
