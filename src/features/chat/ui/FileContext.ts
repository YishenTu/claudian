import type { App, EventRef } from 'obsidian';
import { Notice, TFile } from 'obsidian';

import type { AgentManager } from '../../../core/agents';
import type { McpServerManager } from '../../../core/mcp';
import { MentionDropdownController } from '../../../shared/mention/MentionDropdownController';
import { getVaultPath, normalizePathForVault as normalizePathForVaultUtil } from '../../../utils/path';
import { CanvasChipsView } from './canvas-context/CanvasChipsView';
import { type CanvasContext,CanvasContextManager } from './canvas-context/CanvasContextManager';
import { FileContextState } from './file-context/state/FileContextState';
import { MarkdownFileCache } from './file-context/state/MarkdownFileCache';
import { FileChipsView } from './file-context/view/FileChipsView';

export interface FileContextCallbacks {
  getExcludedTags: () => string[];
  onChipsChanged?: () => void;
  getExternalContexts?: () => string[];
  /** Called when an agent is selected from the @ mention dropdown. */
  onAgentMentionSelect?: (agentId: string) => void;
  /** Called when canvas context changes. */
  onCanvasContextChange?: () => void;
}

export class FileContextManager {
  private app: App;
  private callbacks: FileContextCallbacks;
  private chipsContainerEl: HTMLElement;
  private dropdownContainerEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private state: FileContextState;
  private fileCache: MarkdownFileCache;
  private chipsView: FileChipsView;
  private mentionDropdown: MentionDropdownController;
  private deleteEventRef: EventRef | null = null;
  private renameEventRef: EventRef | null = null;

  // Current note (shown as chip)
  private currentNotePath: string | null = null;

  // MCP server support
  private onMcpMentionChange: ((servers: Set<string>) => void) | null = null;

  // Canvas context support
  private canvasContextManager: CanvasContextManager;
  private canvasChipsView: CanvasChipsView;
  private canvasContextSent = false;

  constructor(
    app: App,
    chipsContainerEl: HTMLElement,
    inputEl: HTMLTextAreaElement,
    callbacks: FileContextCallbacks,
    dropdownContainerEl?: HTMLElement
  ) {
    this.app = app;
    this.chipsContainerEl = chipsContainerEl;
    this.dropdownContainerEl = dropdownContainerEl ?? chipsContainerEl;
    this.inputEl = inputEl;
    this.callbacks = callbacks;

    this.state = new FileContextState();
    this.fileCache = new MarkdownFileCache(this.app);

    this.chipsView = new FileChipsView(this.chipsContainerEl, {
      onRemoveAttachment: (filePath) => {
        if (filePath === this.currentNotePath) {
          // Removing current note
          this.currentNotePath = null;
          this.state.detachFile(filePath);
        } else if (this.state.isAdditionalFile(filePath)) {
          // Removing additional file
          this.state.removeAdditionalFile(filePath);
        }
        this.refreshAllFileChips();
      },
      onOpenFile: async (filePath) => {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
          new Notice(`Could not open file: ${filePath}`);
          return;
        }
        try {
          await this.app.workspace.getLeaf().openFile(file);
        } catch (error) {
          new Notice(`Failed to open file: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });

    this.mentionDropdown = new MentionDropdownController(
      this.dropdownContainerEl,
      this.inputEl,
      {
        onAttachFile: (filePath) => this.state.attachFile(filePath),
        onAttachContextFile: (displayName, absolutePath) =>
          this.state.attachContextFile(displayName, absolutePath),
        onMcpMentionChange: (servers) => this.onMcpMentionChange?.(servers),
        onAgentMentionSelect: (agentId) => this.callbacks.onAgentMentionSelect?.(agentId),
        getMentionedMcpServers: () => this.state.getMentionedMcpServers(),
        setMentionedMcpServers: (mentions) => this.state.setMentionedMcpServers(mentions),
        addMentionedMcpServer: (name) => this.state.addMentionedMcpServer(name),
        getExternalContexts: () => this.callbacks.getExternalContexts?.() || [],
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

    // Initialize Canvas context manager
    this.canvasContextManager = new CanvasContextManager(this.app, {
      onContextChange: () => {
        // Reset the sent flag when context changes, so updated context will be sent
        this.canvasContextSent = false;
        this.refreshCanvasChips();
        this.callbacks.onCanvasContextChange?.();
      },
    });
    this.canvasContextManager.startWatching();

    // Initialize Canvas chips view
    this.canvasChipsView = new CanvasChipsView(this.chipsContainerEl, {
      onOpenCanvas: async (filePath) => {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
          try {
            await this.app.workspace.getLeaf().openFile(file);
          } catch (error) {
            new Notice(`Failed to open canvas: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      },
      onRemoveNode: async (nodeId) => {
        await this.removeCanvasNode(nodeId);
      },
      onRemoveContext: () => {
        this.clearCanvasNodes();
      },
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

  /** Marks all attached files as sent. */
  markAllFilesSent() {
    this.state.markAllFilesSent();
  }

  // ========================================
  // Multi-File Support
  // ========================================

  /**
   * Add a file to the conversation context.
   * Returns true if the file was added, false if it was already attached.
   */
  addFile(filePath: string): boolean {
    const normalizedPath = this.normalizePathForVault(filePath);
    if (!normalizedPath) return false;

    // Don't add if already attached
    if (this.state.getAttachedFiles().has(normalizedPath)) {
      return false;
    }

    this.state.addAdditionalFile(normalizedPath);
    this.refreshAllFileChips();
    return true;
  }

  /**
   * Remove a file from the conversation context.
   */
  removeFile(filePath: string): void {
    const normalizedPath = this.normalizePathForVault(filePath);
    if (!normalizedPath) return;

    if (normalizedPath === this.currentNotePath) {
      this.currentNotePath = null;
      this.state.detachFile(normalizedPath);
    } else {
      this.state.removeAdditionalFile(normalizedPath);
    }
    this.refreshAllFileChips();
  }

  /**
   * Get all attached file paths (current note + additional files).
   */
  getAllAttachedFiles(): string[] {
    const files: string[] = [];
    if (this.currentNotePath) {
      files.push(this.currentNotePath);
    }
    for (const file of this.state.getAdditionalFiles()) {
      if (file !== this.currentNotePath) {
        files.push(file);
      }
    }
    return files;
  }

  /**
   * Get files that haven't been sent yet in this session.
   */
  getUnsentFiles(): string[] {
    return this.state.getUnsentFiles();
  }

  /**
   * Check if a file is attached to the conversation.
   */
  isFileAttached(filePath: string): boolean {
    const normalizedPath = this.normalizePathForVault(filePath);
    if (!normalizedPath) return false;
    return this.state.getAttachedFiles().has(normalizedPath);
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
    this.resetCanvasContextForNewConversation();
  }

  /** Resets state for loading an existing conversation. */
  resetForLoadedConversation(hasMessages: boolean) {
    this.currentNotePath = null;
    this.state.resetForLoadedConversation(hasMessages);
    this.refreshCurrentNoteChip();
    this.canvasContextSent = hasMessages;
    this.refreshCanvasChips();
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

  transformContextMentions(text: string): string {
    return this.state.transformContextMentions(text);
  }

  /** Cleans up event listeners (call on view close). */
  destroy() {
    if (this.deleteEventRef) this.app.vault.offref(this.deleteEventRef);
    if (this.renameEventRef) this.app.vault.offref(this.renameEventRef);
    this.mentionDropdown.destroy();
    this.chipsView.destroy();
    this.canvasContextManager.destroy();
    this.canvasChipsView.destroy();
  }

  /** Normalizes a file path to be vault-relative with forward slashes. */
  normalizePathForVault(rawPath: string | undefined | null): string | null {
    const vaultPath = getVaultPath(this.app);
    return normalizePathForVaultUtil(rawPath, vaultPath);
  }

  private refreshCurrentNoteChip(): void {
    this.refreshAllFileChips();
  }

  /** Refresh all file chips (current note + additional files). */
  private refreshAllFileChips(): void {
    const files: string[] = [];

    // Add current note first
    if (this.currentNotePath) {
      files.push(this.currentNotePath);
    }

    // Add additional files
    for (const file of this.state.getAdditionalFiles()) {
      if (file !== this.currentNotePath) {
        files.push(file);
      }
    }

    this.chipsView.renderFiles(files);
    this.callbacks.onChipsChanged?.();
  }

  private handleFileRenamed(oldPath: string, newPath: string) {
    const normalizedOld = this.normalizePathForVault(oldPath);
    const normalizedNew = this.normalizePathForVault(newPath);
    if (!normalizedOld) return;

    let needsUpdate = false;

    // Update current note path if renamed
    if (this.currentNotePath === normalizedOld) {
      this.currentNotePath = normalizedNew;
      needsUpdate = true;
    }

    // Update attached files
    if (this.state.getAttachedFiles().has(normalizedOld)) {
      this.state.detachFile(normalizedOld);
      if (normalizedNew) {
        this.state.attachFile(normalizedNew);
      }
      this.state.renameAdditionalFile(normalizedOld, normalizedNew ?? normalizedOld);
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
    if (this.state.isAdditionalFile(normalized)) {
      this.state.removeAdditionalFile(normalized);
      needsUpdate = true;
    } else if (this.state.getAttachedFiles().has(normalized)) {
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

  setAgentService(agentManager: AgentManager | null): void {
    // AgentManager structurally satisfies AgentMentionProvider
    this.mentionDropdown.setAgentService(agentManager);
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

  // ========================================
  // Canvas Context Support
  // ========================================

  /** Check if there's an active canvas with selected nodes. */
  hasCanvasContext(): boolean {
    const context = this.canvasContextManager.getCurrentContext();
    return context !== null && context.selectedNodes.length > 0;
  }

  /** Get the current canvas context. */
  getCanvasContext(): CanvasContext | null {
    return this.canvasContextManager.getCurrentContext();
  }

  /** Refresh canvas context (call when user switches tabs, etc.). */
  async refreshCanvasContext(): Promise<CanvasContext | null> {
    return await this.canvasContextManager.refreshContext();
  }

  /** Get formatted canvas context for injection into prompts. */
  getCanvasContextForPrompt(): string | null {
    const context = this.canvasContextManager.getCurrentContext();
    if (!context || context.selectedNodes.length === 0) return null;
    return context.formattedContext;
  }

  /** Check if canvas context should be sent (not yet sent in this session). */
  shouldSendCanvasContext(): boolean {
    return this.hasCanvasContext() && !this.canvasContextSent;
  }

  /** Mark canvas context as sent. */
  markCanvasContextSent(): void {
    this.canvasContextSent = true;
  }

  /** Get a brief description of canvas context for display. */
  getCanvasContextDescription(): string | null {
    return this.canvasContextManager.getContextDescription();
  }

  /** Check if current view is a canvas. */
  isCanvasActive(): boolean {
    return this.canvasContextManager.isCanvasActive();
  }

  private refreshCanvasChips(): void {
    const context = this.canvasContextManager.getCurrentContext();
    this.canvasChipsView.render(context);
    this.callbacks.onChipsChanged?.();
  }

  /** Reset canvas context state for new conversation. */
  resetCanvasContextForNewConversation(): void {
    this.canvasContextSent = false;
    this.canvasContextManager.clearStickyContext();
    this.refreshCanvasChips();
  }

  // ========================================
  // Canvas Node Management
  // ========================================

  /** Remove a specific canvas node from context. */
  async removeCanvasNode(nodeId: string): Promise<void> {
    await this.canvasContextManager.unpinNode(nodeId);
    // Reset the sent flag so the updated context will be sent with the next message
    this.canvasContextSent = false;
    this.refreshCanvasChips();
  }

  /** Clear all canvas nodes from context. */
  clearCanvasNodes(): void {
    this.canvasContextManager.clearPinnedNodes();
    // Reset the sent flag since context has changed
    this.canvasContextSent = false;
    this.refreshCanvasChips();
  }

  /** Check if there are any pinned canvas nodes. */
  hasCanvasNodes(): boolean {
    return this.canvasContextManager.hasPinnedNodes();
  }

  /** Get all pinned canvas nodes. */
  getPinnedCanvasNodes() {
    return this.canvasContextManager.getPinnedNodes();
  }
}
