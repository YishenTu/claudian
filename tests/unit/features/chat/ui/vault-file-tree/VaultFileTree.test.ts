/** @jest-environment jsdom */

import { TFile, TFolder } from 'obsidian';

import { VaultFileTree } from '@/features/chat/ui/vault-file-tree/VaultFileTree';

const mockShowVaultFileTreeMenu = jest.fn();
jest.mock('@/features/chat/ui/vault-file-tree/VaultFileTreeMenu', () => ({
  showVaultFileTreeMenu: (...args: unknown[]) => mockShowVaultFileTreeMenu(...args),
}));

type TreeOptions = {
  composition?: {
    contextMenu?: {
      onOpen?: (item: unknown, context: unknown) => void;
      triggerMode?: string;
    };
  };
  flattenEmptyDirectories?: boolean;
  onSelectionChange?: (paths: readonly string[]) => void;
  paths?: readonly string[];
  search?: boolean;
};

class FakePierreTree {
  static instances: FakePierreTree[] = [];

  cleanUp = jest.fn();
  getItem = jest.fn();
  getSelectedPaths = jest.fn<readonly string[], []>(() => []);
  render = jest.fn();
  resetPaths = jest.fn();
  setSearch = jest.fn();

  constructor(public readonly options: TreeOptions) {
    FakePierreTree.instances.push(this);
  }
}

function createFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.split('/').pop() ?? '';
  file.basename = file.name.replace(/\.[^.]+$/, '');
  file.extension = file.name.includes('.') ? file.name.split('.').pop() ?? '' : '';
  return file;
}

function createFolder(path: string, isRoot = false): TFolder {
  const folder = new TFolder();
  folder.path = path;
  folder.name = path.split('/').pop() ?? '';
  folder.isRoot = jest.fn(() => isRoot);
  return folder;
}

function createHarness() {
  const project = createFolder('Projects');
  const plan = createFile('Projects/Plan.md');
  const hidden = createFile('.obsidian/app.json');
  const root = createFolder('/', true);
  const files = [root, project, plan, hidden];
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const refs: unknown[] = [];
  const openFile = jest.fn().mockResolvedValue(undefined);
  const getLeaf = jest.fn().mockReturnValue({ openFile });
  const app = {
    vault: {
      getAllLoadedFiles: jest.fn(() => files),
      getAbstractFileByPath: jest.fn((path: string) => (
        files.find(file => file.path === path) ?? null
      )),
      offref: jest.fn(),
      on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
        const ref = { event };
        refs.push(ref);
        return ref;
      }),
    },
    workspace: { getLeaf },
  };
  const hostEl = document.createElement('div');
  const onShowSessions = jest.fn();
  const sourceLeaf = { id: 'claudian-leaf' };
  const tree = new VaultFileTree({
    app: app as never,
    hostEl,
    loadTreeModule: async () => ({ FileTree: FakePierreTree }) as never,
    onShowSessions,
    sourceLeaf: sourceLeaf as never,
  });

  return {
    app,
    files,
    getLeaf,
    handlers,
    hostEl,
    onShowSessions,
    openFile,
    refs,
    root,
    sourceLeaf,
    tree,
  };
}

describe('VaultFileTree', () => {
  beforeEach(() => {
    FakePierreTree.instances = [];
    mockShowVaultFileTreeMenu.mockReset();
  });

  it('renders the visible vault through the vanilla Pierre tree', async () => {
    const { hostEl, root, tree } = createHarness();

    await tree.mount();

    const model = FakePierreTree.instances[0];
    expect(model.options).toEqual(expect.objectContaining({
      flattenEmptyDirectories: false,
      paths: ['Projects/', 'Projects/Plan.md'],
      search: false,
    }));
    expect(root.isRoot).toHaveBeenCalledTimes(1);
    expect(model.render).toHaveBeenCalledWith({
      containerWrapper: hostEl.querySelector('.claudian-vault-file-tree-body'),
    });
    expect(hostEl.querySelector('.claudian-vault-file-tree-loading')).toBeNull();
    expect(hostEl.querySelector('.claudian-vault-file-tree-title')?.textContent).toBe('Files');
  });

  it('opens a sole selected file in an existing navigable Obsidian leaf', async () => {
    const { getLeaf, openFile, tree } = createHarness();
    await tree.mount();
    const model = FakePierreTree.instances[0];

    model.options.onSelectionChange?.(['Projects/']);
    model.options.onSelectionChange?.(['Projects/Plan.md', 'Projects/']);
    model.options.onSelectionChange?.(['Projects/Plan.md']);
    await Promise.resolve();
    await Promise.resolve();

    expect(getLeaf).toHaveBeenCalledWith(false);
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'Projects/Plan.md',
    }));
  });

  it('forwards right-click context to the native vault menu boundary', async () => {
    const { app, sourceLeaf, tree } = createHarness();
    await tree.mount();
    const model = FakePierreTree.instances[0];
    const item = { kind: 'file', name: 'Plan.md', path: 'Projects/Plan.md' };
    const context = { anchorElement: document.createElement('div') };
    const focus = jest.fn();
    model.getSelectedPaths.mockReturnValue(['Projects/Plan.md', 'Notes.md']);
    model.getItem.mockReturnValue({ focus });

    expect(model.options.composition?.contextMenu?.triggerMode).toBe('right-click');
    model.options.composition?.contextMenu?.onOpen?.(item, context);

    expect(mockShowVaultFileTreeMenu).toHaveBeenCalledWith(expect.objectContaining({
      app,
      context,
      item,
      selectedPaths: ['Projects/Plan.md', 'Notes.md'],
      sourceLeaf,
    }));

    const options = mockShowVaultFileTreeMenu.mock.calls[0][0];
    options.focusPath('Projects/Plan.md');
    expect(focus).toHaveBeenCalledTimes(1);
    expect(options.isDestroyed()).toBe(false);
    tree.destroy();
    expect(options.isDestroyed()).toBe(true);
  });

  it('filters the tree through an owned file search field', async () => {
    const { hostEl, tree } = createHarness();
    await tree.mount();
    const model = FakePierreTree.instances[0];
    const searchButton = hostEl.querySelector<HTMLButtonElement>('[aria-label="Search files"]');
    const searchField = hostEl.querySelector<HTMLElement>('.claudian-vault-file-tree-search');
    const searchInput = hostEl.querySelector<HTMLInputElement>('.claudian-vault-file-tree-search-input');
    const focusSearchInput = jest.spyOn(searchInput as HTMLInputElement, 'focus');

    expect(searchButton?.getAttribute('aria-expanded')).toBe('false');
    expect(searchField?.classList.contains('claudian-hidden')).toBe(true);
    searchButton?.click();
    expect(searchButton?.getAttribute('aria-expanded')).toBe('true');
    expect(searchField?.classList.contains('claudian-hidden')).toBe(false);
    expect(focusSearchInput).toHaveBeenCalledTimes(1);

    if (!searchInput) throw new Error('Search input was not rendered');
    searchInput.value = 'plan';
    searchInput.dispatchEvent(new Event('input'));
    expect(model.setSearch).toHaveBeenLastCalledWith('plan');

    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input'));
    expect(model.setSearch).toHaveBeenLastCalledWith(null);
    tree.destroy();
  });

  it('defocuses, clears, and hides file search on Escape', async () => {
    const { hostEl, tree } = createHarness();
    await tree.mount();
    const model = FakePierreTree.instances[0];
    const searchButton = hostEl.querySelector<HTMLButtonElement>('[aria-label="Search files"]');
    const searchField = hostEl.querySelector<HTMLElement>('.claudian-vault-file-tree-search');
    const searchInput = hostEl.querySelector<HTMLInputElement>('.claudian-vault-file-tree-search-input');
    const blurSearchInput = jest.spyOn(searchInput as HTMLInputElement, 'blur');
    const focusSearchButton = jest.spyOn(searchButton as HTMLButtonElement, 'focus');

    searchButton?.click();
    if (!searchInput) throw new Error('Search input was not rendered');
    searchInput.value = 'roadmap';
    searchInput.dispatchEvent(new Event('input'));
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(searchInput.value).toBe('');
    expect(model.setSearch).toHaveBeenLastCalledWith(null);
    expect(searchField?.classList.contains('claudian-hidden')).toBe(true);
    expect(searchButton?.getAttribute('aria-expanded')).toBe('false');
    expect(blurSearchInput).toHaveBeenCalledTimes(1);
    expect(focusSearchButton).not.toHaveBeenCalled();
  });

  it('handles Escape through the owning Obsidian view scope', async () => {
    const { hostEl, tree } = createHarness();
    await tree.mount();
    const model = FakePierreTree.instances[0];
    const searchButton = hostEl.querySelector<HTMLButtonElement>('[aria-label="Search files"]');
    const searchField = hostEl.querySelector<HTMLElement>('.claudian-vault-file-tree-search');
    const searchInput = hostEl.querySelector<HTMLInputElement>('.claudian-vault-file-tree-search-input');
    const blurSearchInput = jest.spyOn(searchInput as HTMLInputElement, 'blur');

    searchButton?.click();
    if (!searchInput) throw new Error('Search input was not rendered');
    searchInput.value = 'roadmap';
    searchInput.dispatchEvent(new Event('input'));
    const event = new KeyboardEvent('keydown', { key: 'Escape' });

    expect(tree.handleEscape(event)).toBe(true);
    expect(searchInput.value).toBe('');
    expect(model.setSearch).toHaveBeenLastCalledWith(null);
    expect(searchField?.classList.contains('claudian-hidden')).toBe(true);
    expect(blurSearchInput).toHaveBeenCalledTimes(1);
    expect(tree.handleEscape(event)).toBe(false);
  });

  it('defocuses and hides file search after an outside click', async () => {
    const { hostEl, tree } = createHarness();
    await tree.mount();
    const model = FakePierreTree.instances[0];
    const searchButton = hostEl.querySelector<HTMLButtonElement>('[aria-label="Search files"]');
    const searchField = hostEl.querySelector<HTMLElement>('.claudian-vault-file-tree-search');
    const searchInput = hostEl.querySelector<HTMLInputElement>('.claudian-vault-file-tree-search-input');
    const blurSearchInput = jest.spyOn(searchInput as HTMLInputElement, 'blur');

    searchButton?.click();
    await Promise.resolve();
    if (!searchInput) throw new Error('Search input was not rendered');
    searchInput.value = 'roadmap';
    searchInput.dispatchEvent(new Event('input'));
    document.body.click();
    await Promise.resolve();

    expect(searchInput.value).toBe('');
    expect(model.setSearch).toHaveBeenLastCalledWith(null);
    expect(searchField?.classList.contains('claudian-hidden')).toBe(true);
    expect(blurSearchInput).toHaveBeenCalledTimes(1);
  });

  it('refreshes after structural vault events and releases all resources', async () => {
    const {
      app,
      files,
      handlers,
      hostEl,
      onShowSessions,
      refs,
      tree,
    } = createHarness();
    await tree.mount();
    const model = FakePierreTree.instances[0];

    files.push(createFile('Projects/New.md'));
    handlers.get('create')?.();

    expect(model.resetPaths).toHaveBeenCalledWith([
      'Projects/',
      'Projects/Plan.md',
      'Projects/New.md',
    ]);

    (hostEl.querySelector('[aria-label="Show sessions"]') as HTMLElement).click();
    expect(onShowSessions).toHaveBeenCalledTimes(1);

    tree.destroy();
    tree.destroy();

    expect(model.cleanUp).toHaveBeenCalledTimes(1);
    expect(app.vault.offref.mock.calls.map(call => call[0])).toEqual(refs);
    expect(hostEl.childElementCount).toBe(0);
  });
});
