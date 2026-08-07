import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTree as PierreFileTree,
  FileTreeBatchOperation,
  FileTreeRowDecoration,
} from '@pierre/trees';
import type { App, EventRef, TAbstractFile, WorkspaceLeaf } from 'obsidian';
import { Notice, setIcon, TFile, TFolder } from 'obsidian';

import {
  cancelScheduledAnimationFrame,
  type ScheduledAnimationFrame,
  scheduleDelayedFrame,
} from '@/utils/animationFrame';

import { showVaultFileTreeMenu } from './VaultFileTreeMenu';
import { toVaultFileTreePath, toVaultPath } from './vaultFileTreePaths';

type PierreTreeModule = { FileTree: typeof PierreFileTree };

const MARKDOWN_EXTENSION = '.md';
const PATH_REFRESH_DEBOUNCE_MS = 50;
const SEARCH_RESULT_LIMIT = 500;
const SEARCH_UPDATE_DEBOUNCE_MS = 250;

const VAULT_FILE_TREE_CSS = `
  [data-type="item"] > [data-item-section="content"] {
    display: none;
  }

  [data-type="item"] > [data-item-section="decoration"] {
    color: inherit;
    flex: 1 1 auto;
    justify-content: flex-start;
    text-align: start;
  }

  [data-type="item"] > [data-item-section="decoration"] > span {
    justify-content: flex-start;
  }

  [data-file-tree-virtualized-scroll="true"] {
    scrollbar-width: none;
  }

  [data-file-tree-virtualized-scroll="true"]::-webkit-scrollbar {
    display: none;
    width: 0;
    height: 0;
  }
`;

function renderVaultFileTreeRowDecoration(item: ContextMenuItem): FileTreeRowDecoration | null {
  const shouldHideExtension = item.kind === 'file'
    && item.name.toLowerCase().endsWith(MARKDOWN_EXTENSION);
  const text = shouldHideExtension
    ? item.name.slice(0, -MARKDOWN_EXTENSION.length)
    : item.name;

  return {
    text,
    title: item.name,
  };
}

export type VaultFileTreeOptions = {
  app: App;
  hostEl: HTMLElement;
  loadTreeModule?: () => Promise<PierreTreeModule>;
  sourceLeaf?: WorkspaceLeaf;
};

export class VaultFileTree {
  private readonly options: VaultFileTreeOptions;
  private bodyEl: HTMLElement | null = null;
  private defaultHeaderEl: HTMLElement | null = null;
  private mainTreeHostEl: HTMLElement | null = null;
  private searchButtonEl: HTMLButtonElement | null = null;
  private searchFieldEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private searchPaneEl: HTMLElement | null = null;
  private searchDismissCleanup: (() => void) | null = null;
  private searchQuery = '';
  private searchSourcePaths: readonly string[] | null = null;
  private isSearchComposing = false;
  private pendingSearchUpdate: ScheduledAnimationFrame | null = null;
  private isActive = true;
  private tree: PierreFileTree | null = null;
  private searchTree: PierreFileTree | null = null;
  private treeConstructor: typeof PierreFileTree | null = null;
  private eventRefs: EventRef[] = [];
  private pendingPathMutations: FileTreeBatchOperation[] = [];
  private needsFullPathRefresh = false;
  private pendingPathRefresh: ScheduledAnimationFrame | null = null;
  private mountPromise: Promise<void> | null = null;
  private destroyed = false;
  private pendingOpenPath: string | null = null;
  private isOpeningFile = false;

  constructor(options: VaultFileTreeOptions) {
    this.options = options;
  }

  mount(): Promise<void> {
    this.mountPromise ??= this.mountInternal();
    return this.mountPromise;
  }

  handleEscape(event: KeyboardEvent): boolean {
    if (
      event.key !== 'Escape'
      || event.isComposing
      || this.isSearchComposing
      || this.searchFieldEl?.classList.contains('claudian-hidden') !== false
    ) return false;

    event.preventDefault();
    this.closeFileSearch();
    return true;
  }

  isComposingSearch(): boolean {
    return this.isSearchComposing;
  }

  setActive(active: boolean): void {
    if (this.destroyed || active === this.isActive) return;
    this.isActive = active;

    if (!active) {
      this.cancelSearchUpdate();
      this.closeFileSearch();
      this.cancelScheduledPathRefresh();
      return;
    }

    this.registerVaultEvents();
    if (this.needsFullPathRefresh || this.pendingPathMutations.length > 0) {
      this.schedulePathRefresh();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pendingOpenPath = null;
    this.clearFileSearchDismissHandlers();
    this.cancelSearchUpdate();
    this.cancelPathRefresh();
    this.unregisterVaultEvents();

    this.searchTree?.cleanUp();
    this.searchTree = null;
    this.tree?.cleanUp();
    this.tree = null;
    this.treeConstructor = null;
    this.bodyEl = null;
    this.defaultHeaderEl = null;
    this.mainTreeHostEl = null;
    this.searchButtonEl = null;
    this.searchFieldEl = null;
    this.searchInputEl = null;
    this.searchPaneEl = null;
    this.searchSourcePaths = null;
    this.options.hostEl.replaceChildren();
  }

  private async mountInternal(): Promise<void> {
    this.buildShell();
    this.registerVaultEvents();

    try {
      const module = await (this.options.loadTreeModule?.() ?? import('@pierre/trees'));
      if (this.destroyed || !this.bodyEl || !this.mainTreeHostEl) return;

      const loadingEl = this.bodyEl.querySelector('.claudian-vault-file-tree-loading');
      this.treeConstructor = module.FileTree;
      const tree = this.createTree(this.collectPaths(), 'closed');
      this.tree = tree;
      tree.render({ containerWrapper: this.mainTreeHostEl });
      loadingEl?.remove();
      if (this.searchQuery) this.updateFileSearch(this.searchQuery);
    } catch (error) {
      if (this.destroyed || !this.bodyEl) return;
      this.bodyEl.replaceChildren();
      this.bodyEl.append(this.createElement(
        'div',
        'claudian-vault-file-tree-error',
        'Failed to load files',
      ));
      new Notice(error instanceof Error ? error.message : 'Failed to load vault files');
    }
  }

  private buildShell(): void {
    const { hostEl } = this.options;
    hostEl.replaceChildren();
    hostEl.classList.add('claudian-vault-file-tree');

    const header = this.createElement('div', 'claudian-vault-file-tree-header');
    this.defaultHeaderEl = this.createElement(
      'div',
      'claudian-vault-file-tree-default-header',
    );
    this.defaultHeaderEl.append(this.createElement(
      'div',
      'claudian-vault-file-tree-title',
      this.options.app.vault.getName(),
    ));

    const headerActions = this.createElement('div', 'claudian-vault-file-tree-header-actions');
    this.searchButtonEl = this.createElement(
      'button',
      'claudian-vault-file-tree-header-button',
    );
    this.searchButtonEl.type = 'button';
    this.searchButtonEl.setAttribute('aria-label', 'Search files');
    this.searchButtonEl.setAttribute('aria-expanded', 'false');
    setIcon(this.searchButtonEl, 'search');
    this.searchButtonEl.addEventListener('click', () => {
      if (this.searchFieldEl?.classList.contains('claudian-hidden')) {
        this.openFileSearch();
      } else {
        this.closeFileSearch();
      }
    });

    headerActions.append(this.searchButtonEl);
    this.defaultHeaderEl.append(headerActions);

    this.searchFieldEl = this.createElement(
      'div',
      'claudian-vault-file-tree-search claudian-hidden',
    );
    const searchIcon = this.createElement('span', 'claudian-vault-file-tree-search-icon');
    setIcon(searchIcon, 'search');
    this.searchInputEl = this.createElement(
      'input',
      'claudian-vault-file-tree-search-input',
    );
    this.searchInputEl.type = 'search';
    this.searchInputEl.autocomplete = 'off';
    this.searchInputEl.placeholder = 'Search files';
    this.searchInputEl.setAttribute('aria-label', 'Search files');
    let committedCompositionValue: string | null = null;
    this.searchInputEl.addEventListener('compositionstart', () => {
      this.isSearchComposing = true;
      committedCompositionValue = null;
    });
    this.searchInputEl.addEventListener('compositionend', () => {
      this.isSearchComposing = false;
      committedCompositionValue = this.searchInputEl?.value ?? '';
      this.updateFileSearch(committedCompositionValue);
      queueMicrotask(() => {
        committedCompositionValue = null;
      });
    });
    this.searchInputEl.addEventListener('input', (event) => {
      if (this.isSearchComposing || event.isComposing) return;
      const value = this.searchInputEl?.value ?? '';
      if (committedCompositionValue === value) {
        committedCompositionValue = null;
        return;
      }
      committedCompositionValue = null;
      this.updateFileSearch(value);
    });
    this.searchInputEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (this.isSearchComposing || event.isComposing) {
        event.stopPropagation();
        return;
      }
      this.handleEscape(event);
    });
    this.searchFieldEl.append(this.searchInputEl, searchIcon);
    header.append(this.defaultHeaderEl, this.searchFieldEl);

    this.bodyEl = this.createElement('div', 'claudian-vault-file-tree-body');
    this.bodyEl.append(this.createElement(
      'div',
      'claudian-vault-file-tree-loading',
      'Loading files…',
    ));
    this.mainTreeHostEl = this.createElement('div', 'claudian-vault-file-tree-pane');
    this.searchPaneEl = this.createElement(
      'div',
      'claudian-vault-file-tree-pane claudian-hidden',
    );
    this.bodyEl.addEventListener('click', (event) => this.handleTreeRowClick(event));
    this.bodyEl.append(this.mainTreeHostEl, this.searchPaneEl);
    hostEl.append(header, this.bodyEl);
  }

  private openFileSearch(): void {
    if (
      !this.defaultHeaderEl
      || !this.searchFieldEl
      || !this.searchInputEl
      || !this.searchButtonEl
    ) return;
    this.defaultHeaderEl.classList.add('claudian-hidden');
    this.searchFieldEl.classList.remove('claudian-hidden');
    this.searchButtonEl.setAttribute('aria-expanded', 'true');
    this.searchInputEl.focus();
    this.searchInputEl.setSelectionRange?.(
      this.searchInputEl.value.length,
      this.searchInputEl.value.length,
    );
    this.scheduleFileSearchDismissHandlers();
  }

  private closeFileSearch(): void {
    if (
      !this.searchFieldEl
      || !this.searchInputEl
      || !this.searchButtonEl
      || !this.defaultHeaderEl
      || this.searchFieldEl.classList.contains('claudian-hidden')
    ) return;
    this.clearFileSearchDismissHandlers();
    this.isSearchComposing = false;
    this.searchInputEl.value = '';
    this.updateFileSearch('');
    this.searchInputEl.blur();
    this.searchFieldEl.classList.add('claudian-hidden');
    this.defaultHeaderEl.classList.remove('claudian-hidden');
    this.searchButtonEl.setAttribute('aria-expanded', 'false');
  }

  private updateFileSearch(value: string): void {
    this.searchQuery = value;
    this.cancelSearchUpdate();
    if (!value) {
      this.clearSearchResults();
      if (this.needsFullPathRefresh || this.pendingPathMutations.length > 0) {
        this.schedulePathRefresh();
      }
      return;
    }
    if (!this.isActive || this.destroyed || !this.tree) return;

    this.scheduleSearchUpdate();
  }

  private scheduleSearchUpdate(): void {
    this.cancelSearchUpdate();
    if (!this.searchQuery || !this.isActive || this.destroyed || !this.tree) return;
    this.pendingSearchUpdate = scheduleDelayedFrame(
      () => {
        this.pendingSearchUpdate = null;
        if (!this.isActive || this.destroyed || !this.tree) return;
        this.renderSearchResults();
      },
      SEARCH_UPDATE_DEBOUNCE_MS,
      this.options.hostEl.ownerDocument.defaultView,
    );
  }

  private cancelSearchUpdate(): void {
    if (this.pendingSearchUpdate) cancelScheduledAnimationFrame(this.pendingSearchUpdate);
    this.pendingSearchUpdate = null;
  }

  private renderSearchResults(): void {
    if (
      !this.searchQuery
      || !this.treeConstructor
      || !this.mainTreeHostEl
      || !this.searchPaneEl
    ) return;

    this.searchSourcePaths ??= this.collectPaths();
    const normalizedQuery = this.searchQuery
      .trim()
      .replaceAll('\\', '/')
      .toLowerCase();
    if (!normalizedQuery) {
      this.clearSearchResults();
      return;
    }

    const matchingPaths: string[] = [];
    let truncated = false;
    for (const path of this.searchSourcePaths) {
      if (!path.toLowerCase().includes(normalizedQuery)) continue;
      if (matchingPaths.length === SEARCH_RESULT_LIMIT) {
        truncated = true;
        break;
      }
      matchingPaths.push(path);
    }

    this.searchTree?.cleanUp();
    this.searchPaneEl.replaceChildren();
    this.searchTree = this.createTree(matchingPaths, 'open');
    this.searchTree.render({ containerWrapper: this.searchPaneEl });
    if (truncated) {
      this.searchPaneEl.append(this.createElement(
        'div',
        'claudian-vault-file-tree-search-limit',
        `Showing the first ${SEARCH_RESULT_LIMIT} matches`,
      ));
    }
    this.mainTreeHostEl.classList.add('claudian-hidden');
    this.searchPaneEl.classList.remove('claudian-hidden');
  }

  private clearSearchResults(): void {
    this.searchTree?.cleanUp();
    this.searchTree = null;
    this.searchSourcePaths = null;
    this.searchPaneEl?.replaceChildren();
    this.searchPaneEl?.classList.add('claudian-hidden');
    this.mainTreeHostEl?.classList.remove('claudian-hidden');
  }

  private scheduleFileSearchDismissHandlers(): void {
    queueMicrotask(() => {
      if (
        this.destroyed
        || this.searchFieldEl?.classList.contains('claudian-hidden') !== false
        || !this.searchInputEl
      ) return;

      this.clearFileSearchDismissHandlers();
      const ownerDocument = this.searchInputEl.ownerDocument;
      const ownerWindow = ownerDocument.defaultView;
      let pointerDownOutsideSearch = false;
      const isOutsideSearchField = (event: Event): boolean => {
        const target = event.target;
        return !this.searchFieldEl || !target || !this.searchFieldEl.contains(target as Node);
      };
      const isOutsideSearchUi = (event: Event): boolean => {
        const target = event.target;
        if (!target) return true;
        return (
          !this.searchFieldEl?.contains(target as Node)
          && !this.searchPaneEl?.contains(target as Node)
        );
      };
      const handlePointerDown = (event: Event): void => {
        pointerDownOutsideSearch = isOutsideSearchField(event);
      };
      const handleFocusIn = (event: Event): void => {
        if (!pointerDownOutsideSearch && isOutsideSearchUi(event)) {
          this.closeFileSearch();
        }
      };
      const handleClick = (event: Event): void => {
        const row = this.getTreeRowFromEvent(event);
        const click = event as MouseEvent;
        const isUnmodifiedFileActivation = row?.dataset.itemType === 'file'
          && !click.ctrlKey
          && !click.metaKey
          && !click.shiftKey;
        const isInsideSearchPane = this.searchPaneEl !== null
          && event.composedPath().includes(this.searchPaneEl);
        const shouldDismiss = isOutsideSearchField(event)
          && (!isInsideSearchPane || isUnmodifiedFileActivation);
        pointerDownOutsideSearch = false;
        if (shouldDismiss) queueMicrotask(() => this.closeFileSearch());
      };
      const handlePointerCancel = (): void => {
        pointerDownOutsideSearch = false;
      };
      const handleKeyDown = (): void => {
        pointerDownOutsideSearch = false;
      };
      const handleWindowBlur = (): void => this.closeFileSearch();

      ownerDocument.addEventListener('pointerdown', handlePointerDown, true);
      ownerDocument.addEventListener('pointercancel', handlePointerCancel, true);
      ownerDocument.addEventListener('keydown', handleKeyDown, true);
      ownerDocument.addEventListener('focusin', handleFocusIn, true);
      ownerDocument.addEventListener('click', handleClick, true);
      ownerWindow?.addEventListener('blur', handleWindowBlur);
      this.searchDismissCleanup = () => {
        ownerDocument.removeEventListener('pointerdown', handlePointerDown, true);
        ownerDocument.removeEventListener('pointercancel', handlePointerCancel, true);
        ownerDocument.removeEventListener('keydown', handleKeyDown, true);
        ownerDocument.removeEventListener('focusin', handleFocusIn, true);
        ownerDocument.removeEventListener('click', handleClick, true);
        ownerWindow?.removeEventListener('blur', handleWindowBlur);
      };
    });
  }

  private clearFileSearchDismissHandlers(): void {
    this.searchDismissCleanup?.();
    this.searchDismissCleanup = null;
  }

  private createElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const element = this.options.hostEl.createEl(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  private registerVaultEvents(): void {
    if (this.destroyed || this.eventRefs.length > 0) return;
    this.eventRefs.push(
      this.options.app.vault.on('create', file => {
        const path = this.toTreePath(file);
        if (path !== null) this.queuePathMutation({ path, type: 'add' });
      }),
      this.options.app.vault.on('delete', file => {
        const path = this.toTreePath(file);
        if (path !== null) this.queuePathMutation({ path, recursive: true, type: 'remove' });
      }),
      this.options.app.vault.on('rename', (file, oldPath) => {
        const from = this.toTreePath(file, oldPath);
        const to = this.toTreePath(file);
        if (from === to) return;
        if (from === null) {
          if (to !== null) this.queueVisibleSubtreeAdd(file);
          return;
        }
        if (to === null) {
          this.queuePathMutation({ path: from, recursive: true, type: 'remove' });
          return;
        }
        this.queuePathMutation({ from, to, type: 'move' });
      }),
    );
  }

  private unregisterVaultEvents(): void {
    for (const ref of this.eventRefs) {
      this.options.app.vault.offref(ref);
    }
    this.eventRefs = [];
  }

  private queuePathMutation(operation: FileTreeBatchOperation): void {
    this.queuePathMutations([operation]);
  }

  private queuePathMutations(operations: readonly FileTreeBatchOperation[]): void {
    if (this.destroyed || !this.tree) return;
    if (!this.isActive) {
      this.needsFullPathRefresh = true;
      this.pendingPathMutations = [];
      return;
    }
    let didQueue = false;
    for (const operation of operations) {
      if (this.needsFullPathRefresh) break;
      if (operation.type === 'add') {
        const previous = this.pendingPathMutations.at(-1);
        if (previous?.type === 'add' && previous.path === operation.path) continue;
      }
      this.pendingPathMutations.push(operation);
      didQueue = true;
    }
    if (!didQueue) return;
    if (this.searchQuery) {
      this.searchSourcePaths = null;
      this.scheduleSearchUpdate();
      return;
    }
    this.schedulePathRefresh();
  }

  private queueVisibleSubtreeAdd(file: TAbstractFile): void {
    if (!this.isActive) {
      this.needsFullPathRefresh = true;
      this.pendingPathMutations = [];
      return;
    }
    const operations: FileTreeBatchOperation[] = [];
    const pendingFiles = [file];
    while (pendingFiles.length > 0) {
      const current = pendingFiles.pop();
      if (!current) continue;
      const path = this.toTreePath(current);
      if (path === null) continue;
      operations.push({ path, type: 'add' });
      if (current instanceof TFolder) pendingFiles.push(...current.children);
    }
    this.queuePathMutations(operations);
  }

  private schedulePathRefresh(): void {
    if (this.pendingPathRefresh) return;
    this.pendingPathRefresh = scheduleDelayedFrame(
      () => {
        this.pendingPathRefresh = null;
        this.refreshPaths();
      },
      PATH_REFRESH_DEBOUNCE_MS,
      this.options.hostEl.ownerDocument.defaultView,
    );
  }

  private cancelPathRefresh(): void {
    this.cancelScheduledPathRefresh();
    this.pendingPathMutations = [];
    this.needsFullPathRefresh = false;
  }

  private cancelScheduledPathRefresh(): void {
    if (this.pendingPathRefresh) cancelScheduledAnimationFrame(this.pendingPathRefresh);
    this.pendingPathRefresh = null;
  }

  private refreshPaths(): void {
    if (!this.isActive || this.destroyed || !this.tree) return;
    if (this.searchQuery) return;
    if (this.needsFullPathRefresh) {
      this.needsFullPathRefresh = false;
      this.pendingPathMutations = [];
      const expandedPaths = this.getExpandedPaths();
      this.tree.resetPaths(this.collectPaths(), {
        initialExpandedPaths: expandedPaths,
      });
      return;
    }

    const operations = this.pendingPathMutations;
    this.pendingPathMutations = [];
    if (operations.length === 0) return;

    try {
      this.tree.batch(operations);
    } catch {
      const expandedPaths = this.getExpandedPaths();
      this.tree.resetPaths(this.collectPaths(), { initialExpandedPaths: expandedPaths });
    }
  }

  private getExpandedPaths(): string[] {
    if (!this.tree) return [];
    return this.tree
      .getVisibleRows(0, this.tree.getVisibleCount())
      .filter(row => row.kind === 'directory' && row.isExpanded)
      .map(row => row.path);
  }

  private createTree(
    paths: readonly string[],
    initialExpansion: 'closed' | 'open',
  ): PierreFileTree {
    if (!this.treeConstructor) throw new Error('File tree module is not loaded');
    return new this.treeConstructor({
      composition: {
        contextMenu: {
          onOpen: (item, context) => this.handleContextMenu(item, context),
          triggerMode: 'right-click',
        },
      },
      flattenEmptyDirectories: false,
      initialExpansion,
      paths,
      renderRowDecoration: ({ item }) => renderVaultFileTreeRowDecoration(item),
      search: false,
      stickyFolders: true,
      unsafeCSS: VAULT_FILE_TREE_CSS,
    });
  }

  private collectPaths(): string[] {
    const paths: string[] = [];
    for (const file of this.options.app.vault.getAllLoadedFiles()) {
      if (file instanceof TFolder && file.isRoot()) continue;
      const path = toVaultFileTreePath({
        kind: file instanceof TFolder ? 'folder' : 'file',
        path: file.path,
      });
      if (path !== null) paths.push(path);
    }
    return paths;
  }

  private toTreePath(file: TAbstractFile, path = file.path): string | null {
    return toVaultFileTreePath({
      kind: file instanceof TFolder ? 'folder' : 'file',
      path,
    });
  }

  private handleTreeRowClick(event: MouseEvent): void {
    if (this.destroyed || event.defaultPrevented) return;
    const row = this.getTreeRowFromEvent(event);
    if (!row) return;
    this.pendingOpenPath = null;
    if (
      row.dataset.itemType !== 'file'
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
    ) return;
    const path = row.dataset.itemPath;
    if (!path) return;
    this.pendingOpenPath = toVaultPath(path);
    void this.drainPendingFileOpen();
  }

  private getTreeRowFromEvent(event: Event): HTMLElement | undefined {
    return event.composedPath().find((candidate) => {
      if (typeof candidate !== 'object' || candidate === null || !('dataset' in candidate)) {
        return false;
      }
      const dataset = (candidate as { dataset?: DOMStringMap }).dataset;
      return dataset?.itemPath !== undefined && dataset.itemType !== undefined;
    }) as HTMLElement | undefined;
  }

  private handleContextMenu(item: ContextMenuItem, context: ContextMenuOpenContext): void {
    if (this.destroyed) return;
    const displayedTree = this.searchTree ?? this.tree;
    showVaultFileTreeMenu({
      app: this.options.app,
      context,
      focusPath: path => displayedTree?.getItem(path)?.focus(),
      isDestroyed: () => this.destroyed,
      item,
      selectedPaths: displayedTree?.getSelectedPaths() ?? [],
      sourceLeaf: this.options.sourceLeaf,
    });
  }

  private async drainPendingFileOpen(): Promise<void> {
    if (this.isOpeningFile) return;
    this.isOpeningFile = true;

    try {
      while (!this.destroyed && this.pendingOpenPath !== null) {
        const path = this.pendingOpenPath;
        this.pendingOpenPath = null;
        const file = this.options.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) continue;

        try {
          await this.options.app.workspace.getLeaf(false).openFile(file);
        } catch {
          new Notice(`Failed to open ${file.name}`);
        }
      }
    } finally {
      this.isOpeningFile = false;
    }
  }
}
