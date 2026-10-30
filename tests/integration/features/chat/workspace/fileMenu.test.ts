/** @vitest-environment jsdom */
import { App, Menu, TFile, TFolder } from 'obsidian';

import {
  addFileToClaudian,
  type FileMenuHost,
  registerFileMenu,
} from '@/features/chat/workspace/fileMenu';

const { Menu: HostMenu } = await vi.importActual<typeof import('@test/__mocks__/obsidian')>('obsidian');

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
    const app = new App();
    const appendToActiveInput = vi.fn().mockReturnValue(options.appendResult ?? true);
    const view = { appendToActiveInput };
    const host = {
      app,
      registerEvent: vi.fn(),
      activateView: vi.fn().mockResolvedValue(undefined),
      getView: vi.fn().mockReturnValue(view),
    } satisfies FileMenuHost;

    return {
      appendToActiveInput,
      fireFileMenu: (menu: Menu, file: TFile | TFolder) => app.workspace.trigger('file-menu', menu, file),
      host,
    };
  }

  beforeEach(() => {
    (Menu as typeof Menu & { instances: Menu[] }).instances.length = 0;
  });

  it('registers an Add to Claudian item for files', () => {
    const { fireFileMenu, host } = createHost();

    registerFileMenu(host);
    const menu = new Menu();
    assert(menu instanceof HostMenu);
    fireFileMenu(menu, createFile('projects/plan.md'));

    expect(host.registerEvent).toHaveBeenCalledTimes(1);
    expect((menu).items).toHaveLength(1);
    expect((menu).items[0].title).toBe('Add to Claudian');
  });

  it('does not add the action for folders', () => {
    const { fireFileMenu, host } = createHost();

    registerFileMenu(host);
    const menu = new Menu();
    assert(menu instanceof HostMenu);
    fireFileMenu(menu, new TFolder());

    expect((menu).items).toHaveLength(0);
  });

  it('reveals Claudian and appends the vault-relative mention', async () => {
    const { appendToActiveInput, host } = createHost();
    const file = createFile('projects/My Plan.md');

    await addFileToClaudian(host, file);

    expect(host.activateView).toHaveBeenCalledTimes(1);
    expect(host.getView).toHaveBeenCalledTimes(1);
    expect(appendToActiveInput).toHaveBeenCalledWith('[[projects/My Plan.md|My Plan]] ');
    expect(host.activateView.mock.invocationCallOrder[0])
      .toBeLessThan(appendToActiveInput.mock.invocationCallOrder[0]);
  });
});
