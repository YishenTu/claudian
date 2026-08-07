import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTree as PierreFileTree,
  FileTreeRowDecoration,
} from '@pierre/trees';
import type { App, EventRef, WorkspaceLeaf } from 'obsidian';
import { Notice, setIcon, TFile, TFolder } from 'obsidian';

import { showVaultFileTreeMenu } from './VaultFileTreeMenu';
import {
  collectVaultFileTreePaths,
  toVaultPath,
  type VaultFileTreeEntry,
} from './vaultFileTreePaths';

type PierreTreeModule = { FileTree: typeof PierreFileTree };

const MARKDOWN_EXTENSION = '.md';

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
  private searchButtonEl: HTMLButtonElement | null = null;
  private searchFieldEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private searchDismissCleanup: (() => void) | null = null;
  private searchQuery = '';
  private isSearchComposing = false;
  private tree: PierreFileTree | null = null;
  private eventRefs: EventRef[] = [];
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

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pendingOpenPath = null;
    this.clearFileSearchDismissHandlers();

    for (const ref of this.eventRefs) {
      this.options.app.vault.offref(ref);
    }
    this.eventRefs = [];

    this.tree?.cleanUp();
    this.tree = null;
    this.bodyEl = null;
    this.searchButtonEl = null;
    this.searchFieldEl = null;
    this.searchInputEl = null;
    this.options.hostEl.replaceChildren();
  }

  private async mountInternal(): Promise<void> {
    this.buildShell();
    this.registerVaultEvents();

    try {
      const module = await (this.options.loadTreeModule?.() ?? import('@pierre/trees'));
      if (this.destroyed || !this.bodyEl) return;

      const loadingEl = this.bodyEl.querySelector('.claudian-vault-file-tree-loading');
      const tree = new module.FileTree({
        composition: {
          contextMenu: {
            onOpen: (item, context) => this.handleContextMenu(item, context),
            triggerMode: 'right-click',
          },
        },
        flattenEmptyDirectories: false,
        initialExpansion: 'closed',
        onSelectionChange: paths => this.handleSelectionChange(paths),
        paths: this.collectPaths(),
        renderRowDecoration: ({ item }) => renderVaultFileTreeRowDecoration(item),
        search: false,
        stickyFolders: true,
        unsafeCSS: VAULT_FILE_TREE_CSS,
      });
      this.tree = tree;
      if (this.searchQuery) tree.setSearch(this.searchQuery);
      tree.render({ containerWrapper: this.bodyEl });
      loadingEl?.remove();
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
    header.append(this.createElement(
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
    header.append(headerActions);

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
    this.searchFieldEl.append(searchIcon, this.searchInputEl);

    this.bodyEl = this.createElement('div', 'claudian-vault-file-tree-body');
    this.bodyEl.append(this.createElement(
      'div',
      'claudian-vault-file-tree-loading',
      'Loading files…',
    ));
    hostEl.append(header, this.searchFieldEl, this.bodyEl);
  }

  private openFileSearch(): void {
    if (!this.searchFieldEl || !this.searchInputEl || !this.searchButtonEl) return;
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
      || this.searchFieldEl.classList.contains('claudian-hidden')
    ) return;
    this.clearFileSearchDismissHandlers();
    this.isSearchComposing = false;
    this.searchInputEl.value = '';
    this.updateFileSearch('');
    this.searchInputEl.blur();
    this.searchFieldEl.classList.add('claudian-hidden');
    this.searchButtonEl.setAttribute('aria-expanded', 'false');
  }

  private updateFileSearch(value: string): void {
    this.searchQuery = value;
    this.tree?.setSearch(value || null);
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
      const isOutsideSearch = (event: Event): boolean => {
        const target = event.target;
        return !this.searchFieldEl || !target || !this.searchFieldEl.contains(target as Node);
      };
      const handlePointerDown = (event: Event): void => {
        pointerDownOutsideSearch = isOutsideSearch(event);
      };
      const handleFocusIn = (event: Event): void => {
        if (!pointerDownOutsideSearch && isOutsideSearch(event)) {
          this.closeFileSearch();
        }
      };
      const handleClick = (event: Event): void => {
        const shouldDismiss = isOutsideSearch(event);
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
    const refresh = (): void => this.refreshPaths();
    this.eventRefs.push(
      this.options.app.vault.on('create', refresh),
      this.options.app.vault.on('delete', refresh),
      this.options.app.vault.on('rename', refresh),
    );
  }

  private refreshPaths(): void {
    if (this.destroyed) return;
    this.tree?.resetPaths(this.collectPaths());
  }

  private collectPaths(): string[] {
    const entries: VaultFileTreeEntry[] = this.options.app.vault
      .getAllLoadedFiles()
      .flatMap((file): VaultFileTreeEntry[] => {
        if (file instanceof TFolder && file.isRoot()) return [];
        return [{
          kind: file instanceof TFolder ? 'folder' : 'file',
          path: file.path,
        }];
      });
    return collectVaultFileTreePaths(entries);
  }

  private handleSelectionChange(paths: readonly string[]): void {
    if (this.destroyed || paths.length !== 1 || paths[0].endsWith('/')) return;
    this.pendingOpenPath = toVaultPath(paths[0]);
    void this.drainPendingFileOpen();
  }

  private handleContextMenu(item: ContextMenuItem, context: ContextMenuOpenContext): void {
    if (this.destroyed) return;
    showVaultFileTreeMenu({
      app: this.options.app,
      context,
      focusPath: path => this.tree?.getItem(path)?.focus(),
      isDestroyed: () => this.destroyed,
      item,
      selectedPaths: this.tree?.getSelectedPaths() ?? [],
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
