import type { App, EventRef } from 'obsidian';
import { Notice, TFile, TFolder } from 'obsidian';

import type { McpServerManager } from '../../../core/mcp/McpServerManager';
import type { AgentMentionProvider } from '../../../shared/mention/MentionDropdownController';
import { MentionDropdownController } from '../../../shared/mention/MentionDropdownController';
import { VaultMentionDataProvider } from '../../../shared/mention/VaultMentionDataProvider';
import {
  createExternalContextLookupGetter,
  isMentionStart,
  resolveExternalMentionAtIndex,
} from '../../../utils/contextMentionResolver';
import { buildExternalContextDisplayEntries } from '../../../utils/externalContext';
import { externalContextScanner } from '../../../utils/externalContextScanner';
import {
  getVaultPath,
  normalizePathForVault as normalizePathForVaultUtil,
  rewriteVaultPathAfterRename,
} from '../../../utils/path';
import { ComposerContextTray } from './ComposerContextTray';
import { FileContextState } from './file-context/state/FileContextState';
import { FileChipsView } from './file-context/view/FileChipsView';

export interface FileContextCallbacks {
  getExcludedTags: () => string[];
  onChipsChanged?: () => void;
  onUserChipsChanged?: () => void;
  getExternalContexts?: () => string[];
  /** Called when an agent is selected from the @ mention dropdown. */
  onAgentMentionSelect?: (agentId: string) => void;
}

export class FileContextManager {
  private app: App;
  private callbacks: FileContextCallbacks;
  private dropdownContainerEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private state: FileContextState;
  private mentionDataProvider: VaultMentionDataProvider;
  private chipsView: FileChipsView;
  private mentionDropdown: MentionDropdownController;
  private ownedContextTray: ComposerContextTray | null = null;
  private deleteEventRef: EventRef | null = null;
  private renameEventRef: EventRef | null = null;
  private dropTargetEl: HTMLElement | null = null;
  private dropOverlayEl: HTMLElement | null = null;
  private dragEnterHandler: ((event: DragEvent) => void) | null = null;
  private dragOverHandler: ((event: DragEvent) => void) | null = null;
  private dragLeaveHandler: ((event: DragEvent) => void) | null = null;
  private dropHandler: ((event: DragEvent) => void) | null = null;

  // Current note (shown as chip)
  private currentNotePath: string | null = null;

  // MCP server support
  private onMcpMentionChange: ((servers: Set<string>) => void) | null = null;

  constructor(
    app: App,
    chipsContainerEl: HTMLElement,
    inputEl: HTMLTextAreaElement,
    callbacks: FileContextCallbacks,
    dropdownContainerEl?: HTMLElement,
    contextTray?: ComposerContextTray,
  ) {
    this.app = app;
    this.dropdownContainerEl = dropdownContainerEl ?? chipsContainerEl;
    this.inputEl = inputEl;
    this.callbacks = callbacks;

    this.state = new FileContextState();
    this.mentionDataProvider = new VaultMentionDataProvider(this.app);
    this.mentionDataProvider.initializeInBackground();

    const resolvedContextTray = contextTray ?? new ComposerContextTray(chipsContainerEl);
    if (!contextTray) {
      this.ownedContextTray = resolvedContextTray;
    }
    this.chipsView = new FileChipsView(resolvedContextTray, {
      onRemoveAttachment: (filePath) => {
        if (filePath === this.currentNotePath) {
          this.currentNotePath = null;
          this.state.detachFile(filePath);
          this.refreshCurrentNoteChip();
        }
        this.state.detachFile(filePath);
        this.renderAttachedFiles();
        this.callbacks.onUserChipsChanged?.();
      },
      onOpenFile: (filePath) => {
        void (async (): Promise<void> => {
          try {
            const normalizedPath = filePath.replace(/\/$/, '');
            const file = this.app.vault.getAbstractFileByPath(normalizedPath);
            if (file instanceof TFile) {
              await this.app.workspace.getLeaf().openFile(file);
              return;
            }
            await this.app.workspace.openLinkText(normalizedPath, '', false);
          } catch {
            new Notice(`Could not open file: ${filePath}`);
          }
        })();
      },
    });

    this.mentionDropdown = new MentionDropdownController(
      this.dropdownContainerEl,
      this.inputEl,
      {
        onAttachFile: (filePath) => {
          this.state.attachFile(filePath);
          this.renderAttachedFiles();
        },
        onMcpMentionChange: (servers) => this.onMcpMentionChange?.(servers),
        onAgentMentionSelect: (agentId) => this.callbacks.onAgentMentionSelect?.(agentId),
        getMentionedMcpServers: () => this.state.getMentionedMcpServers(),
        setMentionedMcpServers: (mentions) => this.state.setMentionedMcpServers(mentions),
        addMentionedMcpServer: (name) => this.state.addMentionedMcpServer(name),
        getExternalContexts: () => this.callbacks.getExternalContexts?.() || [],
        getCachedVaultFolders: () => this.mentionDataProvider.getCachedVaultFolders(),
        getCachedVaultFiles: () => this.mentionDataProvider.getCachedVaultFiles(),
        normalizePathForVault: (rawPath) => this.normalizePathForVault(rawPath),
      }
    );
    this.setupDragAndDrop();

    this.deleteEventRef = this.app.vault.on('delete', (file) => {
      if (file instanceof TFile) this.handleFileDeleted(file.path);
    });

    this.renameEventRef = this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile || file instanceof TFolder) {
        this.handleFileRenamed(oldPath, file.path, file instanceof TFolder);
      }
    });
  }

  /** Returns the current note path (shown as chip). */
  getCurrentNotePath(): string | null {
    return this.currentNotePath;
  }

  getAttachedFiles(): Set<string> {
    return this.state.getAttachedFiles();
  }

  /** Checks whether current note should be sent for this session. */
  shouldSendCurrentNote(notePath?: string | null): boolean {
    const resolvedPath = notePath ?? this.currentNotePath;
    return !!resolvedPath && !this.state.hasSentCurrentNote();
  }

  /** Marks current note as sent (call after sending a message). */
  markCurrentNoteSent() {
    this.state.markCurrentNoteSent();
  }

  isSessionStarted(): boolean {
    return this.state.isSessionStarted();
  }

  startSession() {
    this.state.startSession();
  }

  /** Resets state for a new conversation. */
  resetForNewConversation() {
    this.currentNotePath = null;
    this.state.resetForNewConversation();
    this.refreshCurrentNoteChip();
  }

  /** Resets state for loading an existing conversation. */
  resetForLoadedConversation(hasMessages: boolean) {
    this.currentNotePath = null;
    this.state.resetForLoadedConversation(hasMessages);
    this.refreshCurrentNoteChip();
  }

  /** Sets current note (for restoring persisted state). */
  setCurrentNote(notePath: string | null) {
    this.currentNotePath = notePath;
    if (notePath) {
      this.state.attachFile(notePath);
    }
    this.refreshCurrentNoteChip();
  }

  /** Auto-attaches the currently focused file (for new sessions). */
  autoAttachActiveFile() {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && !this.hasExcludedTag(activeFile)) {
      const normalizedPath = this.normalizePathForVault(activeFile.path);
      if (normalizedPath) {
        this.currentNotePath = normalizedPath;
        this.state.attachFile(normalizedPath);
        this.refreshCurrentNoteChip();
      }
    }
  }

  /** Handles file open event. */
  handleFileOpen(file: TFile) {
    const normalizedPath = this.normalizePathForVault(file.path);
    if (!normalizedPath) return;

    if (!this.state.isSessionStarted()) {
      this.state.clearAttachments();
      if (!this.hasExcludedTag(file)) {
        this.currentNotePath = normalizedPath;
        this.state.attachFile(normalizedPath);
      } else {
        this.currentNotePath = null;
      }
      this.refreshCurrentNoteChip();
    }
  }

  markFileCacheDirty() {
    this.mentionDataProvider.markFilesDirty();
  }

  markFolderCacheDirty() {
    this.mentionDataProvider.markFoldersDirty();
  }

  /** Handles input changes to detect @ mentions. */
  handleInputChange() {
    this.mentionDropdown.handleInputChange();
  }

  /** Handles keyboard navigation in mention dropdown. Returns true if handled. */
  handleMentionKeydown(e: KeyboardEvent): boolean {
    return this.mentionDropdown.handleKeydown(e);
  }

  isMentionDropdownVisible(): boolean {
    return this.mentionDropdown.isVisible();
  }

  hideMentionDropdown() {
    this.mentionDropdown.hide();
  }

  containsElement(el: Node): boolean {
    return this.mentionDropdown.containsElement(el);
  }

  transformContextMentions(text: string): string {
    const externalContexts = this.callbacks.getExternalContexts?.() || [];
    if (externalContexts.length === 0 || !text.includes('@')) return text;

    const contextEntries = buildExternalContextDisplayEntries(externalContexts)
      .sort((a, b) => b.displayNameLower.length - a.displayNameLower.length);
    const getContextLookup = createExternalContextLookupGetter(
      contextRoot => externalContextScanner.scanPaths([contextRoot])
    );

    let replaced = false;
    let cursor = 0;
    const chunks: string[] = [];

    for (let index = 0; index < text.length; index++) {
      if (!isMentionStart(text, index)) continue;

      const resolved = resolveExternalMentionAtIndex(text, index, contextEntries, getContextLookup);
      if (!resolved) continue;

      chunks.push(text.slice(cursor, index));
      chunks.push(`${resolved.resolvedPath}${resolved.trailingPunctuation}`);
      cursor = resolved.endIndex;
      index = resolved.endIndex - 1;
      replaced = true;
    }

    if (!replaced) return text;
    chunks.push(text.slice(cursor));
    return chunks.join('');
  }

  /** Cleans up event listeners (call on view close). */
  destroy() {
    if (this.deleteEventRef) this.app.vault.offref(this.deleteEventRef);
    if (this.renameEventRef) this.app.vault.offref(this.renameEventRef);
    this.mentionDropdown.destroy();
    this.chipsView.destroy();
    this.ownedContextTray?.destroy();
    this.ownedContextTray = null;
    if (this.dropTargetEl) {
      if (this.dragEnterHandler) this.dropTargetEl.removeEventListener('dragenter', this.dragEnterHandler as EventListener);
      if (this.dragOverHandler) this.dropTargetEl.removeEventListener('dragover', this.dragOverHandler as EventListener);
      if (this.dragLeaveHandler) this.dropTargetEl.removeEventListener('dragleave', this.dragLeaveHandler as EventListener);
      if (this.dropHandler) this.dropTargetEl.removeEventListener('drop', this.dropHandler as EventListener);
    }
    this.dropOverlayEl?.remove();
    this.dropTargetEl = null;
    this.dropOverlayEl = null;
  }

  /** Normalizes a file path to be vault-relative with forward slashes. */
  normalizePathForVault(rawPath: string | undefined | null): string | null {
    const vaultPath = getVaultPath(this.app);
    return normalizePathForVaultUtil(rawPath, vaultPath);
  }

  private setupDragAndDrop(): void {
    if (typeof this.inputEl.closest !== 'function') return;
    const target = this.inputEl.closest<HTMLElement>('.claudian-input-wrapper');
    if (!target) return;
    if (typeof (target as HTMLElement & { createDiv?: unknown }).createDiv !== 'function') return;
    const overlay = target.createDiv({
      cls: 'claudian-file-drop-overlay claudian-hidden',
      text: 'Drop files or folders to attach',
    });
    let dragDepth = 0;
    this.dragEnterHandler = (event) => {
      event.preventDefault();
      dragDepth += 1;
      overlay.removeClass('claudian-hidden');
    };
    this.dragOverHandler = (event) => event.preventDefault();
    this.dragLeaveHandler = (event) => {
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) overlay.addClass('claudian-hidden');
    };
    this.dropHandler = (event) => {
      event.preventDefault();
      dragDepth = 0;
      overlay.addClass('claudian-hidden');
      const paths = this.resolveDroppedPaths(event.dataTransfer);
      for (const path of paths) this.attachDroppedPath(path);
    };
    target.addEventListener('dragenter', this.dragEnterHandler as EventListener);
    target.addEventListener('dragover', this.dragOverHandler as EventListener);
    target.addEventListener('dragleave', this.dragLeaveHandler as EventListener);
    target.addEventListener('drop', this.dropHandler as EventListener);
    this.dropTargetEl = target;
    this.dropOverlayEl = overlay;
  }

  private resolveDroppedPaths(dataTransfer: DataTransfer | null): string[] {
    if (!dataTransfer) return [];
    const paths: string[] = [];
    const text = dataTransfer.getData('text/plain');
    const uriList = dataTransfer.getData('text/uri-list');
    for (const candidate of [text, uriList]) {
      if (!candidate) continue;
      const uri = candidate.trim().split('\n').find(value => /^obsidian:\/\/open\?/i.test(value));
      if (!uri) continue;
      try {
        const filePath = new URL(uri).searchParams.get('file');
        if (filePath) paths.push(filePath);
      } catch {
        const filePath = uri.match(/[?&]file=([^&]+)/i)?.[1];
        if (filePath) paths.push(decodeURIComponent(filePath));
      }
    }
    for (const file of Array.from(dataTransfer.files ?? [])) {
      const rawPath = (file as File & { path?: string }).path;
      if (rawPath) paths.push(rawPath);
    }
    return [...new Set(paths)];
  }

  private attachDroppedPath(rawPath: string): void {
    const normalized = this.normalizePathForVault(rawPath);
    if (!normalized) return;
    const abstract = this.app.vault.getAbstractFileByPath(normalized);
    const path = abstract instanceof TFolder && !normalized.endsWith('/') ? `${normalized}/` : normalized;
    this.state.attachFile(path);
    this.renderAttachedFiles();
    this.callbacks.onUserChipsChanged?.();
  }

  private refreshCurrentNoteChip(): void {
    this.chipsView.renderCurrentNote(this.currentNotePath);
    this.renderAttachedFiles();
    this.callbacks.onChipsChanged?.();
  }

  private renderAttachedFiles(): void {
    this.chipsView.renderAttachedFiles(this.state.getAttachedFiles(), this.currentNotePath);
  }

  private handleFileRenamed(
    oldPath: string,
    newPath: string,
    includeDescendants = false,
  ): void {
    const normalizedOld = this.normalizePathForVault(oldPath);
    const normalizedNew = this.normalizePathForVault(newPath);
    if (!normalizedOld || !normalizedNew) return;

    let needsUpdate = false;

    const renamedCurrentNote = this.currentNotePath
      ? rewriteVaultPathAfterRename(
          this.currentNotePath,
          normalizedOld,
          normalizedNew,
          includeDescendants,
        )
      : null;
    if (renamedCurrentNote) {
      this.currentNotePath = renamedCurrentNote;
      needsUpdate = true;
    }

    for (const attachedPath of [...this.state.getAttachedFiles()]) {
      const renamedAttachedPath = rewriteVaultPathAfterRename(
        attachedPath,
        normalizedOld,
        normalizedNew,
        includeDescendants,
      );
      if (!renamedAttachedPath) continue;

      this.state.detachFile(attachedPath);
      this.state.attachFile(renamedAttachedPath);
      needsUpdate = true;
    }

    if (needsUpdate) {
      this.refreshCurrentNoteChip();
    }
  }

  private handleFileDeleted(deletedPath: string): void {
    const normalized = this.normalizePathForVault(deletedPath);
    if (!normalized) return;

    let needsUpdate = false;

    // Clear current note if deleted
    if (this.currentNotePath === normalized) {
      this.currentNotePath = null;
      needsUpdate = true;
    }

    // Remove from attached files
    if (this.state.getAttachedFiles().has(normalized)) {
      this.state.detachFile(normalized);
      needsUpdate = true;
    }

    if (needsUpdate) {
      this.refreshCurrentNoteChip();
    }
  }

  // ========================================
  // MCP Server Support
  // ========================================

  setMcpManager(manager: McpServerManager | null): void {
    this.mentionDropdown.setMcpManager(manager);
  }

  setAgentService(agentService: AgentMentionProvider | null): void {
    this.mentionDropdown.setAgentService(agentService);
  }

  setOnMcpMentionChange(callback: (servers: Set<string>) => void): void {
    this.onMcpMentionChange = callback;
  }

  /**
   * Pre-scans external context paths in the background to warm the cache.
   * Should be called when external context paths are added/changed.
   */
  preScanExternalContexts(): void {
    this.mentionDropdown.preScanExternalContexts();
  }

  getMentionedMcpServers(): Set<string> {
    return this.state.getMentionedMcpServers();
  }

  clearMcpMentions(): void {
    this.state.clearMcpMentions();
  }

  updateMcpMentionsFromText(text: string): void {
    this.mentionDropdown.updateMcpMentionsFromText(text);
  }

  private hasExcludedTag(file: TFile): boolean {
    const excludedTags = this.callbacks.getExcludedTags();
    if (excludedTags.length === 0) return false;

    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return false;

    const fileTags: string[] = [];

    if (cache.frontmatter?.tags) {
      const fmTags: unknown = cache.frontmatter.tags;
      if (Array.isArray(fmTags)) {
        fileTags.push(...fmTags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.replace(/^#/, '')));
      } else if (typeof fmTags === 'string') {
        fileTags.push(fmTags.replace(/^#/, ''));
      }
    }

    if (cache.tags) {
      fileTags.push(...cache.tags.map(t => t.tag.replace(/^#/, '')));
    }

    return fileTags.some(tag => excludedTags.includes(tag));
  }
}
