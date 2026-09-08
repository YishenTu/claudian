/** @jest-environment jsdom */

import { fireEvent, waitFor, within } from '@testing-library/dom';

import { registerFileLinkHandler } from '@/utils/fileLink';

describe('registerFileLinkHandler', () => {
  it('opens data-href target when present', () => {
    const app = {
      metadataCache: { getFirstLinkpathDest: jest.fn().mockReturnValue(null) },
      workspace: {
        openLinkText: jest.fn(),
      },
    };

    const link: any = {
      dataset: { href: 'note#section' },
      getAttribute: jest.fn().mockReturnValue('note'),
      closest: jest.fn(),
    };
    link.closest.mockReturnValue(link);

    const event = {
      target: link,
      preventDefault: jest.fn(),
    } as any;

    const container = {
      addEventListener: (_event: string, callback: (event: MouseEvent) => void) => {
        callback(event);
      },
      removeEventListener: jest.fn(),
    };

    const cleanup = registerFileLinkHandler(app as any, container as any);
    cleanup();

    expect(event.preventDefault).toHaveBeenCalled();
    expect(app.workspace.openLinkText).toHaveBeenCalledWith('note#section', '', 'tab');
    expect(container.removeEventListener).toHaveBeenCalledWith('click', expect.any(Function));
  });

  it('falls back to href when data-href is missing', () => {
    const app = {
      metadataCache: { getFirstLinkpathDest: jest.fn().mockReturnValue(null) },
      workspace: {
        openLinkText: jest.fn(),
      },
    };

    const link: any = {
      dataset: {},
      getAttribute: jest.fn().mockReturnValue('note^block'),
      closest: jest.fn(),
    };
    link.closest.mockReturnValue(link);

    const event = {
      target: link,
      preventDefault: jest.fn(),
    } as any;

    const container = {
      addEventListener: (_event: string, callback: (event: MouseEvent) => void) => {
        callback(event);
      },
      removeEventListener: jest.fn(),
    };

    registerFileLinkHandler(app as any, container as any);

    expect(app.workspace.openLinkText).toHaveBeenCalledWith('note^block', '', 'tab');
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
