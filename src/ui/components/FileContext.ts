/**
 * Claudian - File context manager
 *
 * Manages attached files indicator, edited files tracking, and @ mention dropdown.
 * Also handles MCP server @-mentions for context-saving mode.
 */

import type { App, EventRef } from 'obsidian';
import { Notice, TFile } from 'obsidian';
import * as path from 'path';

import type { McpService } from '../../features/mcp/McpService';
import { getVaultPath, isPathWithinVault, normalizePathForFilesystem } from '../../utils/path';
import { MentionDropdownController } from './file-context/mention/MentionDropdownController';
import { EditedFilesTracker } from './file-context/state/EditedFilesTracker';
import { FileContextState } from './file-context/state/FileContextState';
import { MarkdownFileCache } from './file-context/state/MarkdownFileCache';
import { FileChipsView } from './file-context/view/FileChipsView';
import { openFileFromChip } from './file-context/utils/FileOpener';

/** Callbacks for file context interactions. */
export interface FileContextCallbacks {
  getExcludedTags: () => string[];
  onFileOpen: (path: string) => Promise<void>;
  onChipsChanged?: () => void;
  getContextPaths?: () => string[];
}

/** Manages file context UI: attached files, edited files, and @ mention dropdown. */
export class FileContextManager {
  private app: App;
  private callbacks: FileContextCallbacks;
  private containerEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private state: FileContextState;
  private editedFilesTracker: EditedFilesTracker;
  private fileCache: MarkdownFileCache;
  private chipsView: FileChipsView;
  private mentionDropdown: MentionDropdownController;
  private deleteEventRef: EventRef | null = null;
  private renameEventRef: EventRef | null = null;
  private modifyEventRef: EventRef | null = null;

  // MCP server support
  private mcpService: McpService | null = null;
  private onMcpMentionChange: ((servers: Set<string>) => void) | null = null;

  constructor(
    app: App,
    containerEl: HTMLElement,
    inputEl: HTMLTextAreaElement,
    callbacks: FileContextCallbacks
  ) {
    this.app = app;
    this.containerEl = containerEl;
    this.inputEl = inputEl;
    this.callbacks = callbacks;

    this.state = new FileContextState();
    this.fileCache = new MarkdownFileCache(this.app);

    this.editedFilesTracker = new EditedFilesTracker(
      this.app,
      (rawPath) => this.normalizePathForVault(rawPath),
      {
        onEditedFilesChanged: () => this.refreshEditedFiles(true),
        getActiveFile: () => this.app.workspace.getActiveFile(),
      }
    );

    this.chipsView = new FileChipsView(this.containerEl, {
      onRemoveAttachment: (filePath) => {
        this.state.detachFile(filePath);
        this.refreshAttachments();
      },
      onOpenFile: async (filePath) => {
        const result = await openFileFromChip(this.app, (p) => this.normalizePathForVault(p), filePath);
        if (result.openedWithDefaultApp) {
          this.editedFilesTracker.dismissEditedFile(filePath);
          return;
        }
        if (!result.opened) {
          this.notifyOpenFailure(filePath);
        }
      },
      isContextFile: (filePath) => path.isAbsolute(filePath) && !this.isWithinVault(filePath),
      isFileEdited: (filePath) => this.editedFilesTracker.isFileEdited(filePath),
    });

    this.mentionDropdown = new MentionDropdownController(
      this.containerEl,
      this.inputEl,
      {
        onAttachFile: (filePath) => this.state.attachFile(filePath),
        onAttachmentsChanged: () => this.refreshAttachments(),
        onMcpMentionChange: (servers) => this.onMcpMentionChange?.(servers),
        getMentionedMcpServers: () => this.state.getMentionedMcpServers(),
        setMentionedMcpServers: (mentions) => this.state.setMentionedMcpServers(mentions),
        addMentionedMcpServer: (name) => this.state.addMentionedMcpServer(name),
        getContextPaths: () => this.callbacks.getContextPaths?.() || [],
        getCachedMarkdownFiles: () => this.fileCache.getFiles(),
        normalizePathForVault: (rawPath) => this.normalizePathForVault(rawPath),
      }
    );

    this.deleteEventRef = this.app.vault.on('delete', (file) => {
      if (file instanceof TFile) this.handleFileDeleted(file.path);
    });

    this.renameEventRef = this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile) this.handleFileRenamed(oldPath, file.path);
    });

    this.modifyEventRef = this.app.vault.on('modify', (file) => {
      if (file instanceof TFile) this.editedFilesTracker.handleFileModified(file);
    });
  }

  /** Returns the set of currently attached files. */
  getAttachedFiles(): Set<string> {
    return this.state.getAttachedFiles();
  }

  /** Checks if attached files have changed since last sent. */
  hasFilesChanged(): boolean {
    return this.state.hasFilesChanged();
  }

  /** Marks files as sent (call after sending a message). */
  markFilesSent() {
    this.state.markFilesSent();
  }

  isSessionStarted(): boolean {
    return this.state.isSessionStarted();
  }

  startSession() {
    this.state.startSession();
  }

  /** Resets state for a new conversation. */
  resetForNewConversation() {
    this.state.resetForNewConversation();
    this.editedFilesTracker.clear();
    this.refreshAttachments();
  }

  /** Resets state for loading an existing conversation. */
  resetForLoadedConversation(hasMessages: boolean) {
    this.state.resetForLoadedConversation(hasMessages);
    this.editedFilesTracker.clear();
    this.refreshAttachments();
  }

  /** Sets attached files (for restoring persisted state). */
  setAttachedFiles(files: string[]) {
    this.state.setAttachedFiles(files);
    this.refreshAttachments();
  }

  /** Auto-attaches the currently focused file (for new sessions). */
  autoAttachActiveFile() {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && !this.hasExcludedTag(activeFile)) {
      const normalizedPath = this.normalizePathForVault(activeFile.path);
      if (normalizedPath) {
        this.state.attachFile(normalizedPath);
      }
    }
    this.refreshAttachments();
  }

  /** Handles file open event. */
  handleFileOpen(file: TFile) {
    const normalizedPath = this.normalizePathForVault(file.path);
    if (!normalizedPath) return;

    if (this.editedFilesTracker.isFileEdited(normalizedPath)) {
      this.editedFilesTracker.dismissEditedFile(normalizedPath);
    }

    if (!this.state.isSessionStarted()) {
      this.state.clearAttachments();
      if (!this.hasExcludedTag(file)) {
        this.state.attachFile(normalizedPath);
      }
      this.refreshAttachments();
    }

    this.callbacks.onFileOpen(normalizedPath);
  }

  /** Marks a file as being edited (called from PreToolUse hook). */
  async markFileBeingEdited(toolName: string, toolInput: Record<string, unknown>) {
    await this.editedFilesTracker.markFileBeingEdited(toolName, toolInput);
  }

  /** Tracks a file as edited (called from PostToolUse hook). */
  async trackEditedFile(
    toolName: string | undefined,
    toolInput: Record<string, unknown> | undefined,
    isError: boolean
  ) {
    await this.editedFilesTracker.trackEditedFile(toolName, toolInput, isError);
  }

  /** Cleans up state for a file when permission was denied. */
  cancelFileEdit(toolName: string, toolInput: Record<string, unknown>) {
    this.editedFilesTracker.cancelFileEdit(toolName, toolInput);
  }

  markFilesCacheDirty() {
    this.fileCache.markDirty();
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

  /** Cleans up event listeners (call on view close). */
  destroy() {
    if (this.deleteEventRef) this.app.vault.offref(this.deleteEventRef);
    if (this.renameEventRef) this.app.vault.offref(this.renameEventRef);
    if (this.modifyEventRef) this.app.vault.offref(this.modifyEventRef);
    this.mentionDropdown.destroy();
    this.chipsView.destroy();
  }

  /** Normalizes a file path to be vault-relative with forward slashes. */
  normalizePathForVault(rawPath: string | undefined | null): string | null {
    if (!rawPath) return null;

    const normalizedRaw = normalizePathForFilesystem(rawPath);
    const vaultPath = getVaultPath(this.app);

    if (vaultPath && isPathWithinVault(normalizedRaw, vaultPath)) {
      const absolute = path.isAbsolute(normalizedRaw)
        ? normalizedRaw
        : path.resolve(vaultPath, normalizedRaw);
      const relative = path.relative(vaultPath, absolute);
      if (relative) {
        return relative.replace(/\\/g, '/');
      }
      return null;
    }

    return normalizedRaw.replace(/\\/g, '/');
  }

  /** Checks if a path is within the vault using proper path boundary checks. */
  private isWithinVault(filePath: string): boolean {
    const vaultPath = getVaultPath(this.app);
    if (!vaultPath) return false;

    return isPathWithinVault(filePath, vaultPath);
  }

  private notifyOpenFailure(filePath: string): void {
    console.warn(`Failed to open file: ${filePath}`);
    new Notice(`Failed to open file: ${filePath}`);
  }

  private handleFileRenamed(oldPath: string, newPath: string) {
    const normalizedOld = this.normalizePathForVault(oldPath);
    const normalizedNew = this.normalizePathForVault(newPath);
    if (!normalizedOld) return;

    let needsUpdate = false;

    if (this.state.getAttachedFiles().has(normalizedOld)) {
      this.state.detachFile(normalizedOld);
      if (normalizedNew) {
        this.state.attachFile(normalizedNew);
      }
      needsUpdate = true;
    }

    this.editedFilesTracker.handleFileRenamed(oldPath, newPath);

    if (needsUpdate) {
      this.refreshAttachments();
    }
  }

  private handleFileDeleted(path: string): void {
    const normalized = this.normalizePathForVault(path);
    let attachmentsChanged = false;

    if (normalized && this.state.getAttachedFiles().has(normalized)) {
      this.state.detachFile(normalized);
      attachmentsChanged = true;
    }

    this.editedFilesTracker.handleFileDeleted(path);

    if (attachmentsChanged) {
      this.refreshAttachments();
    }
  }

  private getNonAttachedEditedFiles(): string[] {
    const attached = this.state.getAttachedFiles();
    return this.editedFilesTracker.getEditedFiles().filter(path => !attached.has(path));
  }

  private refreshAttachments(): void {
    this.chipsView.renderAttachments(this.state.getAttachedFiles());
    this.refreshEditedFiles();
    this.callbacks.onChipsChanged?.();
  }

  private refreshEditedFiles(refreshAttachments = false): void {
    if (refreshAttachments) {
      this.chipsView.renderAttachments(this.state.getAttachedFiles());
    }
    this.chipsView.renderEditedFiles(this.getNonAttachedEditedFiles(), this.state.isPlanModeActive());
  }

  // ========================================
  // Plan Mode Support
  // ========================================

  /** Set plan mode active state (hides edited files indicator during plan mode). */
  setPlanModeActive(active: boolean): void {
    this.state.setPlanModeActive(active);
    this.editedFilesTracker.setPlanModeActive(active);
    this.refreshEditedFiles();
  }

  // ========================================
  // MCP Server Support
  // ========================================

  /** Set the MCP service for @-mention autocomplete. */
  setMcpService(service: McpService | null): void {
    this.mcpService = service;
    this.mentionDropdown.setMcpService(service);
  }

  /** Set callback for when MCP mentions change (for McpServerSelector integration). */
  setOnMcpMentionChange(callback: (servers: Set<string>) => void): void {
    this.onMcpMentionChange = callback;
  }

  /**
   * Pre-scans context paths in the background to warm the cache.
   * Should be called when context paths are added/changed.
   */
  preScanContextPaths(): void {
    this.mentionDropdown.preScanContextPaths();
  }

  /** Get currently @-mentioned MCP servers. */
  getMentionedMcpServers(): Set<string> {
    return this.state.getMentionedMcpServers();
  }

  /** Clear MCP mentions (call on new conversation). */
  clearMcpMentions(): void {
    this.state.clearMcpMentions();
  }

  /** Update MCP mentions from input text. */
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
      const fmTags = cache.frontmatter.tags;
      if (Array.isArray(fmTags)) {
        fileTags.push(...fmTags.map((t: string) => t.replace(/^#/, '')));
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
