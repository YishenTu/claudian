/** @jest-environment jsdom */

import { TFile, TFolder } from 'obsidian';

import { VaultFileTree } from '@/features/chat/ui/vault-file-tree/VaultFileTree';

const mockShowVaultFileTreeMenu = jest.fn();
const mockShowVaultFileCreateModal = jest.fn();
jest.mock('@/features/chat/ui/vault-file-tree/VaultFileTreeMenu', () => ({
  showVaultFileTreeMenu: (...args: unknown[]) => mockShowVaultFileTreeMenu(...args),
}));
jest.mock('@/features/chat/ui/vault-file-tree/VaultFileCreateModal', () => ({
  showVaultFileCreateModal: (...args: unknown[]) => mockShowVaultFileCreateModal(...args),
}));

type TreeOptions = {
  composition?: {
    contextMenu?: {
      onOpen?: (item: unknown, context: unknown) => void;
      triggerMode?: string;
    };
  };
  flattenEmptyDirectories?: boolean;
  initialExpansion?: 'closed' | 'open';
  onSelectionChange?: (paths: readonly string[]) => void;
  paths?: readonly string[];
  renderRowDecoration?: (context: {
    item: { kind: 'directory' | 'file'; name: string; path: string };
    row: unknown;
  }) => { text: string; title?: string } | null;
  search?: boolean;
  unsafeCSS?: string;
};

type VisibleRow = {
  isExpanded: boolean;
  kind: 'directory' | 'file';
  path: string;
};

class FakePierreTree {
  static instances: FakePierreTree[] = [];

  batch = jest.fn();
  cleanUp = jest.fn();
  getItem = jest.fn();
  getSelectedPaths = jest.fn<readonly string[], []>(() => []);
  getVisibleCount = jest.fn(() => 0);
  getVisibleRows = jest.fn<readonly VisibleRow[], [number, number]>(() => []);
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

function createTreeRow(
  hostEl: HTMLElement,
  path: string,
  type: 'file' | 'folder',
): HTMLButtonElement {
  let container = hostEl.querySelector<HTMLElement>('file-tree-container');
  if (!container) {
    container = hostEl.ownerDocument.createElement('file-tree-container');
    container.attachShadow({ mode: 'open' });
    hostEl.append(container);
  }
  const row = hostEl.ownerDocument.createElement('button');
  row.dataset.itemPath = path;
  row.dataset.itemType = type;
  container.shadowRoot?.append(row);
  return row;
}

function createHarness(ownerDocument: Document = document) {
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
    fileManager: {
      getNewFileParent: jest.fn(() => project),
    },
    vault: {
      getAllLoadedFiles: jest.fn(() => files),
      getAbstractFileByPath: jest.fn((path: string) => (
        files.find(file => file.path === path) ?? null
      )),
      getRoot: jest.fn(() => root),
      getName: jest.fn(() => 'Knowledge Vault'),
      offref: jest.fn(),
      on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
        const ref = { event };
        refs.push(ref);
        return ref;
      }),
    },
    workspace: {
      getActiveFile: jest.fn(() => plan),
      getLeaf,
    },
  };
  const hostEl = ownerDocument.createElement('div');
  Object.assign(hostEl, {
    createEl: <K extends keyof HTMLElementTagNameMap>(tag: K) => ownerDocument.createElement(tag),
  });
  const tree = new VaultFileTree({
    app: app as never,
    hostEl,
    loadTreeModule: async () => ({ FileTree: FakePierreTree }) as never,
  });

  return {
    app,
    files,
    getLeaf,
    handlers,
    hostEl,
    openFile,
    project,
    refs,
    root,
    tree,
  };
}

describe('VaultFileTree', () => {
  beforeEach(() => {
    FakePierreTree.instances = [];
    mockShowVaultFileCreateModal.mockReset();
    mockShowVaultFileTreeMenu.mockReset();
  });

  it('offers root note and folder creation from the tree header', async () => {
    const { app, hostEl, project, root, tree } = createHarness();

    await tree.mount();
    hostEl.querySelector<HTMLButtonElement>('[aria-label="New note"]')?.click();
    hostEl.querySelector<HTMLButtonElement>('[aria-label="New folder"]')?.click();

    expect(mockShowVaultFileCreateModal.mock.calls).toEqual([
      [app, project, 'note'],
      [app, root, 'folder'],
    ]);
    expect(app.fileManager.getNewFileParent).toHaveBeenCalledWith('Projects/Plan.md');
  });

  it('renders the visible vault through the vanilla Pierre tree', async () => {
    const { hostEl, root, tree } = createHarness();

    await tree.mount();

    const model = FakePierreTree.instances[0];
    expect(model.options).toEqual(expect.objectContaining({
      flattenEmptyDirectories: false,
      paths: ['Projects/', 'Projects/Plan.md'],
      search: false,
      unsafeCSS: expect.stringContaining('scrollbar-width: none'),
    }));
    expect(model.options.unsafeCSS).toContain('::-webkit-scrollbar');
    expect(model.options.unsafeCSS).toContain(
      '[data-type="item"] > [data-item-section="content"]',
    );
    expect(model.options.unsafeCSS).not.toContain('truncate-marker');
    expect(root.isRoot).toHaveBeenCalledTimes(1);
    expect(model.render).toHaveBeenCalledWith({
      containerWrapper: hostEl.querySelector('.claudian-vault-file-tree-pane'),
    });
    expect(hostEl.querySelector('.claudian-vault-file-tree-loading')).toBeNull();
    expect(hostEl.querySelector('.claudian-vault-file-tree-title')?.textContent)
      .toBe('Knowledge Vault');
  });

  it('renders every item with end truncation without changing vault path identity', async () => {
    const { tree } = createHarness();

    await tree.mount();

    const model = FakePierreTree.instances[0];
    const renderRowDecoration = model.options.renderRowDecoration;
    const row = {};

    expect(model.options.paths).toContain('Projects/Plan.md');
    expect(renderRowDecoration?.({
      item: { kind: 'file', name: 'Plan.md', path: 'Projects/Plan.md' },
      row,
    })).toEqual({ text: 'Plan', title: 'Plan.md' });
    expect(renderRowDecoration?.({
      item: { kind: 'file', name: 'README.MD', path: 'README.MD' },
      row,
    })).toEqual({ text: 'README', title: 'README.MD' });
    expect(renderRowDecoration?.({
      item: { kind: 'file', name: 'Board.canvas', path: 'Board.canvas' },
      row,
    })).toEqual({ text: 'Board.canvas', title: 'Board.canvas' });
    expect(renderRowDecoration?.({
      item: { kind: 'directory', name: 'Notes.md', path: 'Notes.md' },
      row,
    })).toEqual({ text: 'Notes.md', title: 'Notes.md' });
  });

  it('opens an activated file in an existing navigable Obsidian leaf', async () => {
    const { getLeaf, hostEl, openFile, tree } = createHarness();
    await tree.mount();
    const treePane = hostEl.querySelector<HTMLElement>('.claudian-vault-file-tree-pane');
    if (!treePane) throw new Error('Tree pane was not rendered');
    const folderRow = createTreeRow(treePane, 'Projects/', 'folder');
    const fileRow = createTreeRow(treePane, 'Projects/Plan.md', 'file');

    folderRow.click();
    fileRow.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(getLeaf).toHaveBeenCalledWith(false);
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'Projects/Plan.md',
    }));
  });

  it('reopens repeated file activations and ignores modifier selection clicks', async () => {
    const { hostEl, openFile, tree } = createHarness();
    await tree.mount();
    const treePane = hostEl.querySelector<HTMLElement>('.claudian-vault-file-tree-pane');
    if (!treePane) throw new Error('Tree pane was not rendered');
    const fileRow = createTreeRow(treePane, 'Projects/Plan.md', 'file');

    fileRow.click();
    await Promise.resolve();
    fileRow.click();
    await Promise.resolve();
    fileRow.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      composed: true,
      ctrlKey: true,
    }));
    fileRow.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      composed: true,
      detail: 0,
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(openFile).toHaveBeenCalledTimes(3);
  });

  it('opens files from a pop-out window DOM realm', async () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const ownerDocument = iframe.contentDocument;
    if (!ownerDocument) throw new Error('Pop-out document was not created');
    const { hostEl, openFile, tree } = createHarness(ownerDocument);
    ownerDocument.body.append(hostEl);
    await tree.mount();
    const treePane = hostEl.querySelector<HTMLElement>('.claudian-vault-file-tree-pane');
    if (!treePane) throw new Error('Tree pane was not rendered');
    const fileRow = createTreeRow(treePane, 'Projects/Plan.md', 'file');

    expect(fileRow instanceof HTMLElement).toBe(false);
    fileRow.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(openFile).toHaveBeenCalledTimes(1);
    tree.destroy();
    iframe.remove();
  });

  it('drops a queued file open when activation moves away from that file', async () => {
    const { files, hostEl, openFile, tree } = createHarness();
    const later = createFile('Projects/Later.md');
    files.push(later);
    let finishFirstOpen: (() => void) | undefined;
    openFile.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishFirstOpen = resolve;
    }));
    await tree.mount();
    const treePane = hostEl.querySelector<HTMLElement>('.claudian-vault-file-tree-pane');
    if (!treePane) throw new Error('Tree pane was not rendered');
    const firstRow = createTreeRow(treePane, 'Projects/Plan.md', 'file');
    const laterRow = createTreeRow(treePane, 'Projects/Later.md', 'file');
    const folderRow = createTreeRow(treePane, 'Projects/', 'folder');

    firstRow.click();
    await Promise.resolve();
    laterRow.click();
    folderRow.click();
    finishFirstOpen?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'Projects/Plan.md',
    }));
  });

  it('forwards right-click context to the native vault menu boundary', async () => {
    const { app, tree } = createHarness();
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
    }));

    const options = mockShowVaultFileTreeMenu.mock.calls[0][0];
    options.focusPath('Projects/Plan.md');
    expect(focus).toHaveBeenCalledTimes(1);
    expect(options.isDestroyed()).toBe(false);
    tree.destroy();
    expect(options.isDestroyed()).toBe(true);
  });

  it('filters the tree through an owned file search field', async () => {
    const { files, handlers, hostEl, tree } = createHarness();
    await tree.mount();
    const model = FakePierreTree.instances[0];
    const header = hostEl.querySelector<HTMLElement>('.claudian-vault-file-tree-header');
    const defaultHeader = hostEl.querySelector<HTMLElement>(
      '.claudian-vault-file-tree-default-header',
    );
    const searchButton = hostEl.querySelector<HTMLButtonElement>('[aria-label="Search files"]');
    const searchField = hostEl.querySelector<HTMLElement>('.claudian-vault-file-tree-search');
    const searchInput = hostEl.querySelector<HTMLInputElement>('.claudian-vault-file-tree-search-input');
    const focusSearchInput = jest.spyOn(searchInput as HTMLInputElement, 'focus');

    expect(searchField?.parentElement).toBe(header);
    expect(hostEl.children).toHaveLength(2);
    expect(defaultHeader?.classList.contains('claudian-hidden')).toBe(false);
    expect(searchButton?.getAttribute('aria-expanded')).toBe('false');
    expect(searchField?.classList.contains('claudian-hidden')).toBe(true);
    searchButton?.click();
    expect(defaultHeader?.classList.contains('claudian-hidden')).toBe(true);
    expect(searchButton?.getAttribute('aria-expanded')).toBe('true');
    expect(searchField?.classList.contains('claudian-hidden')).toBe(false);
    expect(searchField?.lastElementChild?.classList.contains(
      'claudian-vault-file-tree-search-icon',
    )).toBe(true);
    expect(focusSearchInput).toHaveBeenCalledTimes(1);

    jest.useFakeTimers();
    try {
      if (!searchInput) throw new Error('Search input was not rendered');
      searchInput.value = 'plan';
      searchInput.dispatchEvent(new Event('input'));
      expect(model.setSearch).not.toHaveBeenCalled();
      jest.advanceTimersByTime(300);
      const searchModel = FakePierreTree.instances[1];
      expect(searchModel.options).toEqual(expect.objectContaining({
        initialExpansion: 'open',
        paths: ['Projects/Plan.md'],
      }));
      expect(model.setSearch).not.toHaveBeenCalled();
      const panes = hostEl.querySelectorAll<HTMLElement>('.claudian-vault-file-tree-pane');
      expect(panes[0].classList.contains('claudian-hidden')).toBe(true);
      expect(panes[1].classList.contains('claudian-hidden')).toBe(false);

      const created = createFile('Projects/Plan update.md');
      files.push(created);
      handlers.get('create')?.(created);
      jest.advanceTimersByTime(100);
      expect(model.batch).not.toHaveBeenCalled();
      jest.advanceTimersByTime(200);
      const refreshedSearchModel = FakePierreTree.instances[2];
      expect(refreshedSearchModel.options.paths).toEqual([
        'Projects/Plan.md',
        'Projects/Plan update.md',
      ]);
      expect(searchModel.cleanUp).toHaveBeenCalledTimes(1);

      searchInput.value = 'roadmap';
      searchInput.dispatchEvent(new Event('input'));
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input'));
      expect(refreshedSearchModel.cleanUp).toHaveBeenCalledTimes(1);
      expect(panes[0].classList.contains('claudian-hidden')).toBe(false);
      expect(panes[1].classList.contains('claudian-hidden')).toBe(true);
      jest.advanceTimersByTime(100);
      expect(model.batch).toHaveBeenCalledTimes(1);

      searchInput.value = 'cancelled';
      searchInput.dispatchEvent(new Event('input'));
      tree.setActive(false);
      jest.advanceTimersByTime(300);
      expect(FakePierreTree.instances).toHaveLength(3);
      expect(model.setSearch).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
    tree.destroy();
  });

  it('bounds the rendered search tree for broad queries', async () => {
    const { files, hostEl, tree } = createHarness();
    for (let index = 0; index < 501; index += 1) {
      files.push(createFile(`Bulk/Result ${index}.md`));
    }
    await tree.mount();
    const searchButton = hostEl.querySelector<HTMLButtonElement>('[aria-label="Search files"]');
    const searchInput = hostEl.querySelector<HTMLInputElement>(
      '.claudian-vault-file-tree-search-input',
    );

    jest.useFakeTimers();
    try {
      searchButton?.click();
      if (!searchInput) throw new Error('Search input was not rendered');
      searchInput.value = 'result';
      searchInput.dispatchEvent(new Event('input'));
      jest.advanceTimersByTime(300);

      expect(FakePierreTree.instances[1].options.paths).toHaveLength(500);
      expect(hostEl.querySelector('.claudian-vault-file-tree-search-limit')?.textContent)
        .toBe('Showing the first 500 matches');
      expect(FakePierreTree.instances[0].setSearch).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
    tree.destroy();
  });

  it('keeps search open when keyboard focus moves into its result tree', async () => {
    const { hostEl, tree } = createHarness();
    document.body.append(hostEl);
    await tree.mount();
    const searchButton = hostEl.querySelector<HTMLButtonElement>('[aria-label="Search files"]');
    const searchField = hostEl.querySelector<HTMLElement>('.claudian-vault-file-tree-search');
    const searchInput = hostEl.querySelector<HTMLInputElement>(
      '.claudian-vault-file-tree-search-input',
    );

    jest.useFakeTimers();
    try {
      searchButton?.click();
      await Promise.resolve();
      if (!searchInput) throw new Error('Search input was not rendered');
      searchInput.value = 'plan';
      searchInput.dispatchEvent(new Event('input'));
      jest.advanceTimersByTime(300);
      const resultButton = document.createElement('button');
      hostEl.querySelector('.claudian-vault-file-tree-pane:not(.claudian-hidden)')
        ?.append(resultButton);
      resultButton.focus();

      expect(searchField?.classList.contains('claudian-hidden')).toBe(false);
      expect(FakePierreTree.instances[1].cleanUp).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
    tree.destroy();
    hostEl.remove();
  });

  it('keeps search open for modifier selection and folder interaction', async () => {
    const { hostEl, tree } = createHarness();
    document.body.append(hostEl);
    await tree.mount();
    const searchButton = hostEl.querySelector<HTMLButtonElement>('[aria-label="Search files"]');
    const searchField = hostEl.querySelector<HTMLElement>('.claudian-vault-file-tree-search');
    const searchInput = hostEl.querySelector<HTMLInputElement>(
      '.claudian-vault-file-tree-search-input',
    );

    jest.useFakeTimers();
    try {
      searchButton?.click();
      await Promise.resolve();
      if (!searchInput) throw new Error('Search input was not rendered');
      searchInput.value = 'plan';
      searchInput.dispatchEvent(new Event('input'));
      jest.advanceTimersByTime(300);
      const searchPane = hostEl.querySelector<HTMLElement>(
        '.claudian-vault-file-tree-pane:not(.claudian-hidden)',
      );
      if (!searchPane) throw new Error('Search results were not rendered');
      const fileRow = createTreeRow(searchPane, 'Projects/Plan.md', 'file');
      const folderRow = createTreeRow(searchPane, 'Projects/', 'folder');

      fileRow.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        composed: true,
        metaKey: true,
      }));
      jest.runAllTicks();
      expect(searchField?.classList.contains('claudian-hidden')).toBe(false);

      folderRow.click();
      jest.runAllTicks();
      expect(searchField?.classList.contains('claudian-hidden')).toBe(false);
      expect(FakePierreTree.instances[1].cleanUp).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
    tree.destroy();
    hostEl.remove();
  });

  it('defocuses, clears, and hides file search on Escape', async () => {
    const { hostEl, tree } = createHarness();
    await tree.mount();
    const defaultHeader = hostEl.querySelector<HTMLElement>(
      '.claudian-vault-file-tree-default-header',
    );
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
    expect(FakePierreTree.instances).toHaveLength(1);
    expect(searchField?.classList.contains('claudian-hidden')).toBe(true);
    expect(defaultHeader?.classList.contains('claudian-hidden')).toBe(false);
    expect(searchButton?.getAttribute('aria-expanded')).toBe('false');
    expect(blurSearchInput).toHaveBeenCalledTimes(1);
    expect(focusSearchButton).not.toHaveBeenCalled();
  });

  it('handles Escape through the owning Obsidian view scope', async () => {
    const { hostEl, tree } = createHarness();
    await tree.mount();
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
    expect(FakePierreTree.instances).toHaveLength(1);
    expect(searchField?.classList.contains('claudian-hidden')).toBe(true);
    expect(blurSearchInput).toHaveBeenCalledTimes(1);
    expect(tree.handleEscape(event)).toBe(false);
  });

  it('defocuses and hides file search after an outside click', async () => {
    const { hostEl, tree } = createHarness();
    await tree.mount();
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
    expect(FakePierreTree.instances).toHaveLength(1);
    expect(searchField?.classList.contains('claudian-hidden')).toBe(true);
    expect(blurSearchInput).toHaveBeenCalledTimes(1);
  });

  it('coalesces structural vault events and suspends refresh work while inactive', async () => {
    const {
      app,
      files,
      handlers,
      hostEl,
      refs,
      tree,
    } = createHarness();
    await tree.mount();
    const model = FakePierreTree.instances[0];
    model.getVisibleCount.mockReturnValue(2);
    model.getVisibleRows.mockReturnValue([
      { isExpanded: true, kind: 'directory', path: 'Projects/' },
      { isExpanded: false, kind: 'file', path: 'Projects/Plan.md' },
    ]);

    jest.useFakeTimers();
    try {
      const created = createFile('Projects/New.md');
      files.push(created);
      handlers.get('create')?.(created);

      expect(model.batch).not.toHaveBeenCalled();
      expect(model.resetPaths).not.toHaveBeenCalled();
      jest.advanceTimersByTime(100);

      expect(model.batch).toHaveBeenCalledTimes(1);
      expect(model.batch).toHaveBeenLastCalledWith([
        { path: 'Projects/New.md', type: 'add' },
      ]);
      expect(model.resetPaths).not.toHaveBeenCalled();

      created.path = 'Projects/Renamed.md';
      created.name = 'Renamed.md';
      handlers.get('rename')?.(created, 'Projects/New.md');
      handlers.get('delete')?.(created);
      files.splice(files.indexOf(created), 1);
      jest.advanceTimersByTime(100);
      expect(model.batch).toHaveBeenCalledTimes(2);
      expect(model.batch).toHaveBeenLastCalledWith([
        { from: 'Projects/New.md', to: 'Projects/Renamed.md', type: 'move' },
        { path: 'Projects/Renamed.md', recursive: true, type: 'remove' },
      ]);

      const original = createFile('Projects/Reused.md');
      handlers.get('create')?.(original);
      original.path = 'Projects/Moved.md';
      original.name = 'Moved.md';
      handlers.get('rename')?.(original, 'Projects/Reused.md');
      handlers.get('create')?.(createFile('Projects/Reused.md'));
      jest.advanceTimersByTime(100);
      expect(model.batch).toHaveBeenCalledTimes(3);
      expect(model.batch).toHaveBeenLastCalledWith([
        { path: 'Projects/Reused.md', type: 'add' },
        { from: 'Projects/Reused.md', to: 'Projects/Moved.md', type: 'move' },
        { path: 'Projects/Reused.md', type: 'add' },
      ]);

      const revealedFolder = createFolder('Revealed');
      revealedFolder.children = [createFile('Revealed/Child.md')];
      handlers.get('rename')?.(revealedFolder, '.hidden');
      jest.advanceTimersByTime(100);
      expect(model.batch).toHaveBeenCalledTimes(4);
      expect(model.batch).toHaveBeenLastCalledWith([
        { path: 'Revealed/', type: 'add' },
        { path: 'Revealed/Child.md', type: 'add' },
      ]);
      expect(model.resetPaths).not.toHaveBeenCalled();

      tree.setActive(false);
      const later = createFile('Projects/Later.md');
      files.push(later);
      handlers.get('create')?.(later);
      jest.advanceTimersByTime(100);
      expect(model.batch).toHaveBeenCalledTimes(4);
      expect(model.resetPaths).not.toHaveBeenCalled();

      tree.setActive(true);
      jest.advanceTimersByTime(100);
      expect(model.resetPaths).toHaveBeenCalledTimes(1);
      expect(model.resetPaths).toHaveBeenLastCalledWith(
        [
          'Projects/',
          'Projects/Plan.md',
          'Projects/Later.md',
        ],
        { initialExpandedPaths: ['Projects/'] },
      );
      expect(app.vault.getAllLoadedFiles).toHaveBeenCalledTimes(2);

      tree.setActive(false);
      tree.setActive(true);
      jest.advanceTimersByTime(100);
      expect(model.resetPaths).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }

    expect(hostEl.querySelector('[aria-label="Show sessions"]')).toBeNull();

    tree.destroy();
    tree.destroy();

    expect(model.cleanUp).toHaveBeenCalledTimes(1);
    expect(app.vault.offref.mock.calls.map(call => call[0])).toEqual(refs);
    expect(hostEl.childElementCount).toBe(0);
  });
});
