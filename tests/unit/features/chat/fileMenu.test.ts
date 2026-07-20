import { Menu, TFile, TFolder } from 'obsidian';

import {
  addFileToClaudian,
  registerFileMenu,
} from '@/features/chat/fileMenu';

describe('Claudian file menu', () => {
  function createFile(path: string): TFile {
    const file = new TFile();
    file.path = path;
    file.name = path.split('/').pop() ?? path;
    file.basename = file.name.replace(/\.[^.]+$/, '');
    file.extension = file.name.split('.').pop() ?? '';
    return file;
  }

  function createHost(options: { appendResult?: boolean } = {}) {
    let fileMenuHandler: ((menu: Menu, file: TFile | TFolder) => void) | null = null;
    const eventRef = { id: 'file-menu-ref' };
    const appendToActiveInput = jest.fn().mockReturnValue(options.appendResult ?? true);
    const view = { appendToActiveInput };
    const host = {
      app: {
        workspace: {
          on: jest.fn((event: string, handler: typeof fileMenuHandler) => {
            if (event === 'file-menu') fileMenuHandler = handler;
            return eventRef;
          }),
        },
      },
      registerEvent: jest.fn(),
      activateView: jest.fn().mockResolvedValue(undefined),
      getView: jest.fn().mockReturnValue(view),
    };

    return {
      appendToActiveInput,
      eventRef,
      getFileMenuHandler: () => fileMenuHandler,
      host,
    };
  }

  beforeEach(() => {
    (Menu as typeof Menu & { instances: Menu[] }).instances.length = 0;
  });

  it('registers an Add to Claudian item for files', () => {
    const { eventRef, getFileMenuHandler, host } = createHost();

    registerFileMenu(host as never);
    const menu = new Menu();
    getFileMenuHandler()?.(menu, createFile('projects/plan.md'));

    expect(host.registerEvent).toHaveBeenCalledWith(eventRef);
    expect((menu as any).items).toHaveLength(1);
    expect((menu as any).items[0].title).toBe('Add to Claudian');
  });

  it('does not add the action for folders', () => {
    const { getFileMenuHandler, host } = createHost();

    registerFileMenu(host as never);
    const menu = new Menu();
    getFileMenuHandler()?.(menu, new TFolder());

    expect((menu as any).items).toHaveLength(0);
  });

  it('reveals Claudian and appends the vault-relative mention', async () => {
    const { appendToActiveInput, host } = createHost();
    const file = createFile('projects/My Plan.md');

    await addFileToClaudian(host as never, file);

    expect(host.activateView).toHaveBeenCalledTimes(1);
    expect(host.getView).toHaveBeenCalledTimes(1);
    expect(appendToActiveInput).toHaveBeenCalledWith('@projects/My Plan.md ');
    expect(host.activateView.mock.invocationCallOrder[0])
      .toBeLessThan(appendToActiveInput.mock.invocationCallOrder[0]);
  });
});
