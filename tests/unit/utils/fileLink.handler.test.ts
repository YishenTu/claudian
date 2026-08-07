import { registerFileLinkHandler } from '@/utils/fileLink';

describe('registerFileLinkHandler', () => {
  it('opens data-href target when present', () => {
    const app = {
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
