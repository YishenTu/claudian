/**
 * Claudian - File context manager
 *
 * Manages attached files indicator, edited files tracking, and @ mention dropdown.
 * Also handles MCP server @-mentions for context-saving mode.
 */

import { createHash } from 'crypto';
import type { App, EventRef } from 'obsidian';
import { Notice, setIcon, TFile } from 'obsidian';
import * as path from 'path';

import { isEditTool } from '../../core/tools/toolNames';
import type { McpService } from '../../features/mcp/McpService';
import { getFolderName, normalizePathForComparison } from '../../utils/contextPath';
import { type ContextPathFile, contextPathScanner } from '../../utils/contextPathScanner';
import { extractMcpMentions } from '../../utils/mcp';
import { getVaultPath, isPathWithinVault, normalizePathForFilesystem } from '../../utils/path';

interface FileHashState {
  originalHash: string | null;
  postEditHash: string;
}

/** Union type for @-mention dropdown items. */
interface MentionItem {
  type: 'file' | 'mcp-server' | 'context-file' | 'context-folder';
  name: string;
  path?: string;           // For vault files
  absolutePath?: string;   // For context path files
  contextRoot?: string;    // For context path files
  folderName?: string;     // For context folder filters and display labels
}

interface ContextPathEntry {
  contextRoot: string;
  folderName: string;
  displayName: string;
  displayNameLower: string;
}

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
  private fileIndicatorEl: HTMLElement;
  private editedFilesIndicatorEl: HTMLElement;
  private mentionDropdown: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement;
  private attachedFiles: Set<string> = new Set();
  private lastSentFiles: Set<string> = new Set();
  private editedFilesThisSession: Set<string> = new Set();
  private sessionStarted = false;
  private editedFileHashes: Map<string, FileHashState> = new Map();
  private filesBeingEdited: Set<string> = new Set();
  private deleteEventRef: EventRef | null = null;
  private renameEventRef: EventRef | null = null;
  private modifyEventRef: EventRef | null = null;
  private mentionStartIndex = -1;
  private selectedMentionIndex = 0;
  private filteredFiles: TFile[] = [];
  private filteredMentionItems: MentionItem[] = [];
  private filteredContextFiles: ContextPathFile[] = [];
  private cachedMarkdownFiles: TFile[] = [];
  private filesCacheDirty = true;

  // MCP server support
  private mcpService: McpService | null = null;
  private mentionedMcpServers: Set<string> = new Set();
  private onMcpMentionChange: ((servers: Set<string>) => void) | null = null;

  // Plan mode state
  private planModeActive = false;

  // Context folder filter state
  private activeContextFilter: { folderName: string; contextRoot: string } | null = null;

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

    const firstChild = this.containerEl.firstChild;
    this.editedFilesIndicatorEl = this.containerEl.createDiv({ cls: 'claudian-edited-files-indicator' });
    this.fileIndicatorEl = this.containerEl.createDiv({ cls: 'claudian-file-indicator' });
    if (firstChild) {
      this.containerEl.insertBefore(this.editedFilesIndicatorEl, firstChild);
      this.containerEl.insertBefore(this.fileIndicatorEl, firstChild);
    }

    this.deleteEventRef = this.app.vault.on('delete', (file) => {
      if (file instanceof TFile) this.handleFileDeleted(file.path);
    });

    this.renameEventRef = this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile) this.handleFileRenamed(oldPath, file.path);
    });

    this.modifyEventRef = this.app.vault.on('modify', (file) => {
      if (file instanceof TFile) this.handleFileModified(file);
    });
  }

  /** Returns the set of currently attached files. */
  getAttachedFiles(): Set<string> {
    return this.attachedFiles;
  }

  /** Checks if attached files have changed since last sent. */
  hasFilesChanged(): boolean {
    const currentFiles = Array.from(this.attachedFiles);
    if (currentFiles.length !== this.lastSentFiles.size) return true;
    for (const file of currentFiles) {
      if (!this.lastSentFiles.has(file)) return true;
    }
    return false;
  }

  /** Marks files as sent (call after sending a message). */
  markFilesSent() {
    this.lastSentFiles = new Set(this.attachedFiles);
  }

  isSessionStarted(): boolean {
    return this.sessionStarted;
  }

  startSession() {
    this.sessionStarted = true;
  }

  /** Resets state for a new conversation. */
  resetForNewConversation() {
    this.sessionStarted = false;
    this.lastSentFiles.clear();
    this.attachedFiles.clear();
    this.clearEditedFiles();
    this.clearMcpMentions();
  }

  /** Resets state for loading an existing conversation. */
  resetForLoadedConversation(hasMessages: boolean) {
    this.lastSentFiles.clear();
    this.attachedFiles.clear();
    this.sessionStarted = hasMessages;
    this.clearEditedFiles();
    this.clearMcpMentions();
  }

  /** Sets attached files (for restoring persisted state). */
  setAttachedFiles(files: string[]) {
    this.attachedFiles.clear();
    for (const file of files) {
      this.attachedFiles.add(file);
    }
    this.lastSentFiles = new Set(this.attachedFiles);
    this.updateFileIndicator();
  }

  /** Auto-attaches the currently focused file (for new sessions). */
  autoAttachActiveFile() {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && !this.hasExcludedTag(activeFile)) {
      const normalizedPath = this.normalizePathForVault(activeFile.path);
      if (normalizedPath) {
        this.attachedFiles.add(normalizedPath);
      }
    }
    this.updateFileIndicator();
  }

  /** Handles file open event. */
  handleFileOpen(file: TFile) {
    const normalizedPath = this.normalizePathForVault(file.path);
    if (!normalizedPath) return;

    if (this.isFileEdited(normalizedPath)) {
      this.dismissEditedFile(normalizedPath);
    }

    if (!this.sessionStarted) {
      this.attachedFiles.clear();
      if (!this.hasExcludedTag(file)) {
        this.attachedFiles.add(normalizedPath);
      }
      this.updateFileIndicator();
    }

    this.callbacks.onFileOpen(normalizedPath);
  }

  /** Marks a file as being edited (called from PreToolUse hook). */
  async markFileBeingEdited(toolName: string, toolInput: Record<string, unknown>) {
    // Skip tracking during plan mode (agent only writes to ~/.claude/plans/)
    if (this.planModeActive) return;
    if (!isEditTool(toolName)) return;

    const rawPath = (toolInput?.file_path as string) || (toolInput?.notebook_path as string);
    const path = this.normalizePathForVault(rawPath);
    if (!path) return;

    const wasBeingEdited = this.filesBeingEdited.has(path);
    this.filesBeingEdited.add(path);

    if (!wasBeingEdited) {
      const originalHash = await this.computeFileHash(path);
      this.editedFileHashes.set(path, { originalHash, postEditHash: '' });
    }
  }

  /** Tracks a file as edited (called from PostToolUse hook). */
  async trackEditedFile(toolName: string | undefined, toolInput: Record<string, unknown> | undefined, isError: boolean) {
    // Skip tracking during plan mode (agent only writes to ~/.claude/plans/)
    if (this.planModeActive) return;
    if (!toolName || !isEditTool(toolName)) return;

    const rawPath = (toolInput?.file_path as string) || (toolInput?.notebook_path as string);
    const filePath = this.normalizePathForVault(rawPath);
    if (!filePath) return;

    if (isError) {
      this.filesBeingEdited.delete(filePath);
      if (!this.editedFilesThisSession.has(filePath)) {
        this.editedFileHashes.delete(filePath);
      }
      return;
    }

    const postEditHash = await this.computeFileHash(filePath);
    const existing = this.editedFileHashes.get(filePath);

    this.filesBeingEdited.delete(filePath);

    if (postEditHash) {
      if (existing?.originalHash && postEditHash === existing.originalHash) {
        this.editedFilesThisSession.delete(filePath);
        this.editedFileHashes.delete(filePath);
        this.updateEditedFilesIndicator();
        this.updateFileIndicator();
        return;
      }

      this.editedFileHashes.set(filePath, {
        originalHash: existing?.originalHash ?? null,
        postEditHash
      });
    }

    this.editedFilesThisSession.add(filePath);

    // If the edited file is currently focused, immediately dismiss the indicator
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      const activePath = this.normalizePathForVault(activeFile.path);
      if (activePath === filePath) {
        this.dismissEditedFile(filePath);
        return;
      }
    }

    this.updateEditedFilesIndicator();
    this.updateFileIndicator();
  }

  /** Cleans up state for a file when permission was denied. */
  cancelFileEdit(toolName: string, toolInput: Record<string, unknown>) {
    if (!isEditTool(toolName)) return;

    const rawPath = (toolInput?.file_path as string) || (toolInput?.notebook_path as string);
    const path = this.normalizePathForVault(rawPath);
    if (!path) return;

    this.filesBeingEdited.delete(path);

    if (!this.editedFilesThisSession.has(path)) {
      this.editedFileHashes.delete(path);
    }
  }

  markFilesCacheDirty() {
    this.filesCacheDirty = true;
  }

  /** Handles input changes to detect @ mentions. */
  handleInputChange() {
    const text = this.inputEl.value;
    this.updateMcpMentionsFromText(text);
    const cursorPos = this.inputEl.selectionStart || 0;

    const textBeforeCursor = text.substring(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      this.hideMentionDropdown();
      return;
    }

    const charBeforeAt = lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : ' ';
    if (!/\s/.test(charBeforeAt) && lastAtIndex !== 0) {
      this.hideMentionDropdown();
      return;
    }

    const searchText = textBeforeCursor.substring(lastAtIndex + 1);

    if (/\s/.test(searchText)) {
      this.hideMentionDropdown();
      return;
    }

    this.mentionStartIndex = lastAtIndex;
    this.showMentionDropdown(searchText);
  }

  /** Handles keyboard navigation in mention dropdown. Returns true if handled. */
  handleMentionKeydown(e: KeyboardEvent): boolean {
    if (!this.mentionDropdown?.hasClass('visible')) {
      return false;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.navigateMentionDropdown(1);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.navigateMentionDropdown(-1);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      this.selectMentionItem();
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.hideMentionDropdown();
      return true;
    }
    return false;
  }

  isMentionDropdownVisible(): boolean {
    return this.mentionDropdown?.hasClass('visible') ?? false;
  }

  hideMentionDropdown() {
    this.mentionDropdown?.removeClass('visible');
    this.mentionStartIndex = -1;
  }

  containsElement(el: Node): boolean {
    return this.mentionDropdown?.contains(el) ?? false;
  }

  /** Cleans up event listeners (call on view close). */
  destroy() {
    if (this.deleteEventRef) this.app.vault.offref(this.deleteEventRef);
    if (this.renameEventRef) this.app.vault.offref(this.renameEventRef);
    if (this.modifyEventRef) this.app.vault.offref(this.modifyEventRef);
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

  private updateFileIndicator() {
    this.fileIndicatorEl.empty();

    if (this.attachedFiles.size === 0) {
      this.fileIndicatorEl.style.display = 'none';
      this.updateEditedFilesIndicator();
      this.callbacks.onChipsChanged?.();
      return;
    }

    this.fileIndicatorEl.style.display = 'flex';

    for (const filePath of this.attachedFiles) {
      this.renderFileChip(filePath, () => {
        this.attachedFiles.delete(filePath);
        this.updateFileIndicator();
      });
    }

    // Keep edited files indicator in sync with attachment changes
    this.updateEditedFilesIndicator();
    this.callbacks.onChipsChanged?.();
  }

  private renderFileChip(filePath: string, onRemove: () => void) {
    const chipEl = this.fileIndicatorEl.createDiv({ cls: 'claudian-file-chip' });

    // Check if this is a context path file (absolute path outside vault)
    const isContextFile = path.isAbsolute(filePath) && !this.isWithinVault(filePath);

    if (isContextFile) {
      chipEl.addClass('claudian-file-chip-context');
    }

    // Add edited class if file was edited this session
    if (this.isFileEdited(filePath)) {
      chipEl.addClass('claudian-file-chip-edited');
    }

    const iconEl = chipEl.createSpan({ cls: 'claudian-file-chip-icon' });
    setIcon(iconEl, isContextFile ? 'folder-open' : 'file-text');

    // Normalize path separators and extract filename
    const normalizedPath = filePath.replace(/\\/g, '/');
    const filename = normalizedPath.split('/').pop() || filePath;
    const nameEl = chipEl.createSpan({ cls: 'claudian-file-chip-name' });
    nameEl.setText(filename);
    nameEl.setAttribute('title', filePath);

    const removeEl = chipEl.createSpan({ cls: 'claudian-file-chip-remove' });
    removeEl.setText('\u00D7');
    removeEl.setAttribute('aria-label', 'Remove');

    chipEl.addEventListener('click', async (e) => {
      if ((e.target as HTMLElement).closest('.claudian-file-chip-remove')) return;
      await this.openFileFromChip(filePath);
    });

    removeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove();
    });
  }

  /** Checks if a path is within the vault using proper path boundary checks. */
  private isWithinVault(filePath: string): boolean {
    const vaultPath = getVaultPath(this.app);
    if (!vaultPath) return false;

    return isPathWithinVault(filePath, vaultPath);
  }

  private async openFileFromChip(filePath: string) {
    const normalizedPath = this.normalizePathForVault(filePath);
    if (!normalizedPath) {
      this.notifyOpenFailure(filePath);
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (file instanceof TFile) {
      try {
        await this.app.workspace.getLeaf('tab').openFile(file);
        return;
      } catch (error) {
        console.error('Failed to open file in workspace:', error);
        const vaultPath = getVaultPath(this.app);
        const absolutePath = vaultPath ? path.join(vaultPath, file.path) : file.path;
        const opened = await this.openWithDefaultApp(absolutePath);
        if (opened) {
          this.dismissEditedFile(filePath);
          return;
        }
        this.notifyOpenFailure(filePath);
        return;
      }
    }

    if (path.isAbsolute(normalizedPath)) {
      const opened = await this.openWithDefaultApp(normalizedPath);
      if (opened) {
        this.dismissEditedFile(filePath);
        return;
      }
      this.notifyOpenFailure(filePath);
      return;
    }

    this.notifyOpenFailure(filePath);
  }

  private async openWithDefaultApp(filePath: string): Promise<boolean> {
    if (!filePath) return false;

    const appAny = this.app as any;
    if (typeof appAny.openWithDefaultApp === 'function') {
      try {
        await appAny.openWithDefaultApp(filePath);
        return true;
      } catch (err) {
        console.error('Failed to open file in default app:', err);
        return false;
      }
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { shell } = require('electron');
      if (shell?.openPath) {
        const result = await shell.openPath(filePath);
        if (result) {
          console.error('Failed to open file in default app:', result);
          return false;
        }
        return true;
      }
      if (shell?.openExternal) {
        const target = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
        await shell.openExternal(target);
        return true;
      }
    } catch (err) {
      console.error('Failed to open file in default app:', err);
    }

    return false;
  }

  private clearEditedFiles() {
    this.editedFilesThisSession.clear();
    this.editedFileHashes.clear();
    this.filesBeingEdited.clear();
    this.updateFileIndicator();
  }

  private dismissEditedFile(path: string) {
    const normalizedPath = this.normalizePathForVault(path);
    if (!normalizedPath) return;

    if (this.filesBeingEdited.has(normalizedPath)) return;

    if (this.editedFilesThisSession.has(normalizedPath)) {
      this.editedFilesThisSession.delete(normalizedPath);
      this.editedFileHashes.delete(normalizedPath);
      this.updateEditedFilesIndicator();
      this.updateFileIndicator();
    }
  }

  private isFileEdited(path: string): boolean {
    const normalizedPath = this.normalizePathForVault(path);
    if (!normalizedPath) return false;
    return this.editedFilesThisSession.has(normalizedPath);
  }

  private async computeFileHash(path: string): Promise<string | null> {
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return null;
      const content = await this.app.vault.read(file);
      return await this.computeContentHash(content);
    } catch (error) {
      console.warn('Failed to compute file hash:', error);
      return null;
    }
  }

  private notifyOpenFailure(filePath: string) {
    console.warn(`Failed to open file: ${filePath}`);
    new Notice(`Failed to open file: ${filePath}`);
  }

  private async computeContentHash(content: string): Promise<string> {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoded = new TextEncoder().encode(content);
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Fallback for environments without WebCrypto
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  private handleFileDeleted(path: string) {
    const normalized = this.normalizePathForVault(path);
    if (normalized && this.editedFilesThisSession.has(normalized)) {
      this.editedFilesThisSession.delete(normalized);
      this.editedFileHashes.delete(normalized);
      this.filesBeingEdited.delete(normalized);
      this.updateEditedFilesIndicator();
      this.updateFileIndicator();
    }
  }

  private handleFileRenamed(oldPath: string, newPath: string) {
    const normalizedOld = this.normalizePathForVault(oldPath);
    const normalizedNew = this.normalizePathForVault(newPath);
    if (!normalizedOld) return;

    let needsUpdate = false;

    if (this.attachedFiles.has(normalizedOld)) {
      this.attachedFiles.delete(normalizedOld);
      if (normalizedNew) {
        this.attachedFiles.add(normalizedNew);
      }
      needsUpdate = true;
    }

    if (this.editedFilesThisSession.has(normalizedOld)) {
      this.editedFilesThisSession.delete(normalizedOld);
      const hashState = this.editedFileHashes.get(normalizedOld);
      this.editedFileHashes.delete(normalizedOld);

      if (normalizedNew) {
        this.editedFilesThisSession.add(normalizedNew);
        if (hashState) this.editedFileHashes.set(normalizedNew, hashState);
      }
      needsUpdate = true;
    }

    if (this.filesBeingEdited.has(normalizedOld)) {
      this.filesBeingEdited.delete(normalizedOld);
      if (normalizedNew) {
        this.filesBeingEdited.add(normalizedNew);
      }
    }

    if (needsUpdate) {
      this.updateEditedFilesIndicator();
      this.updateFileIndicator();
    }
  }

  private async handleFileModified(file: TFile) {
    const normalized = this.normalizePathForVault(file.path);
    if (!normalized) return;

    if (this.filesBeingEdited.has(normalized)) return;

    if (!this.editedFilesThisSession.has(normalized)) return;

    const hashState = this.editedFileHashes.get(normalized);
    if (!hashState) return;

    const currentHash = await this.computeFileHash(normalized);
    if (!currentHash) return;

    if (hashState.originalHash && currentHash === hashState.originalHash) {
      this.editedFilesThisSession.delete(normalized);
      this.editedFileHashes.delete(normalized);
      this.updateEditedFilesIndicator();
      this.updateFileIndicator();
    }
  }

  private getNonAttachedEditedFiles(): string[] {
    return [...this.editedFilesThisSession].filter(path => !this.attachedFiles.has(path));
  }

  private shouldShowEditedFilesSection(): boolean {
    return this.getNonAttachedEditedFiles().length > 0;
  }

  private updateEditedFilesIndicator() {
    this.editedFilesIndicatorEl.empty();

    // Hide during plan mode or if no edited files
    if (this.planModeActive || !this.shouldShowEditedFilesSection()) {
      this.editedFilesIndicatorEl.style.display = 'none';
      return;
    }

    this.editedFilesIndicatorEl.style.display = 'flex';

    const label = this.editedFilesIndicatorEl.createSpan({ cls: 'claudian-edited-label' });
    label.setText('Edited:');

    for (const path of this.getNonAttachedEditedFiles()) {
      this.renderEditedFileChip(path);
    }
  }

  private renderEditedFileChip(filePath: string) {
    const chipEl = this.editedFilesIndicatorEl.createDiv({ cls: 'claudian-file-chip claudian-file-chip-edited' });

    const iconEl = chipEl.createSpan({ cls: 'claudian-file-chip-icon' });
    setIcon(iconEl, 'file-text');

    // Normalize path separators and extract filename
    const normalizedPath = filePath.replace(/\\/g, '/');
    const filename = normalizedPath.split('/').pop() || filePath;
    const nameEl = chipEl.createSpan({ cls: 'claudian-file-chip-name' });
    nameEl.setText(filename);
    nameEl.setAttribute('title', filePath);

    chipEl.addEventListener('click', async () => {
      await this.openFileFromChip(filePath);
    });
  }

  private getCachedMarkdownFiles(): TFile[] {
    if (this.filesCacheDirty || this.cachedMarkdownFiles.length === 0) {
      this.cachedMarkdownFiles = this.app.vault.getMarkdownFiles();
      this.filesCacheDirty = false;
    }
    return this.cachedMarkdownFiles;
  }

  // ========================================
  // Plan Mode Support
  // ========================================

  /** Set plan mode active state (hides edited files indicator during plan mode). */
  setPlanModeActive(active: boolean): void {
    this.planModeActive = active;
    this.updateEditedFilesIndicator();
  }

  // ========================================
  // MCP Server Support
  // ========================================

  /** Set the MCP service for @-mention autocomplete. */
  setMcpService(service: McpService | null): void {
    this.mcpService = service;
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
    const contextPaths = this.callbacks.getContextPaths?.() || [];
    if (contextPaths.length === 0) return;

    // Run scan asynchronously to avoid blocking UI
    setTimeout(() => {
      try {
        contextPathScanner.scanPaths(contextPaths);
      } catch (err) {
        console.warn('Failed to pre-scan context paths:', err instanceof Error ? err.message : String(err));
      }
    }, 0);
  }

  /** Get currently @-mentioned MCP servers. */
  getMentionedMcpServers(): Set<string> {
    return new Set(this.mentionedMcpServers);
  }

  /** Clear MCP mentions (call on new conversation). */
  clearMcpMentions(): void {
    this.mentionedMcpServers.clear();
  }

  /** Update MCP mentions from input text. */
  updateMcpMentionsFromText(text: string): void {
    if (!this.mcpService) return;

    const validNames = new Set(
      this.mcpService.getContextSavingServers().map(s => s.name)
    );

    const newMentions = extractMcpMentions(text, validNames);

    // Update if changed
    const changed = newMentions.size !== this.mentionedMcpServers.size ||
      [...newMentions].some(n => !this.mentionedMcpServers.has(n));

    if (changed) {
      this.mentionedMcpServers = newMentions;
      // Notify McpServerSelector about new mentions
      this.onMcpMentionChange?.(newMentions);
    }
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

  private buildContextPathEntries(contextPaths: string[]): ContextPathEntry[] {
    const counts = new Map<string, number>();
    const normalizedPaths = new Map<string, string>();

    for (const contextPath of contextPaths) {
      const normalized = normalizePathForComparison(contextPath);
      normalizedPaths.set(contextPath, normalized);
      const folderName = getFolderName(normalized);
      counts.set(folderName, (counts.get(folderName) ?? 0) + 1);
    }

    return contextPaths.map(contextRoot => {
      const normalized = normalizedPaths.get(contextRoot) ?? normalizePathForComparison(contextRoot);
      const folderName = getFolderName(contextRoot);
      const needsDisambiguation = (counts.get(folderName) ?? 0) > 1;
      const displayName = this.getContextDisplayName(normalized, folderName, needsDisambiguation);
      return {
        contextRoot,
        folderName,
        displayName,
        displayNameLower: displayName.toLowerCase(),
      };
    });
  }

  private getContextDisplayName(
    normalizedPath: string,
    folderName: string,
    needsDisambiguation: boolean
  ): string {
    if (!needsDisambiguation) return folderName;

    const segments = normalizedPath.split('/').filter(Boolean);
    if (segments.length < 2) return folderName;

    const parent = segments[segments.length - 2];
    if (!parent) return folderName;

    return `${parent}/${folderName}`;
  }

  private showMentionDropdown(searchText: string) {
    const searchLower = searchText.toLowerCase();
    this.filteredMentionItems = [];
    this.filteredContextFiles = [];

    const contextPaths = this.callbacks.getContextPaths?.() || [];
    const contextEntries = this.buildContextPathEntries(contextPaths);

    // Check if user is typing a context folder filter (e.g., @workspace/)
    const isFilterSearch = searchText.includes('/');
    let fileSearchText = searchLower;

    if (isFilterSearch) {
      const matchingContext = contextEntries
        .filter(entry => searchLower.startsWith(`${entry.displayNameLower}/`))
        .sort((a, b) => b.displayNameLower.length - a.displayNameLower.length)[0];

      if (matchingContext) {
        const prefixLength = matchingContext.displayName.length + 1;
        fileSearchText = searchText.substring(prefixLength).toLowerCase();
        this.activeContextFilter = {
          folderName: matchingContext.displayName,
          contextRoot: matchingContext.contextRoot,
        };
      } else {
        this.activeContextFilter = null;
      }
    }

    // If we have an active filter from @folder/ pattern, only show files from that context
    if (this.activeContextFilter && isFilterSearch) {
      const contextFiles = contextPathScanner.scanPaths([this.activeContextFilter.contextRoot]);
      this.filteredContextFiles = contextFiles
        .filter(file => {
          const relativePath = file.relativePath.replace(/\\/g, '/');
          const pathLower = relativePath.toLowerCase();
          const nameLower = file.name.toLowerCase();
          return pathLower.includes(fileSearchText) || nameLower.includes(fileSearchText);
        })
        .sort((a, b) => {
          const aNameMatch = a.name.toLowerCase().startsWith(fileSearchText);
          const bNameMatch = b.name.toLowerCase().startsWith(fileSearchText);
          if (aNameMatch && !bNameMatch) return -1;
          if (!aNameMatch && bNameMatch) return 1;
          return b.mtime - a.mtime;
        })
        .slice(0, 10);

      for (const file of this.filteredContextFiles) {
        const relativePath = file.relativePath.replace(/\\/g, '/');
        this.filteredMentionItems.push({
          type: 'context-file',
          name: relativePath,
          absolutePath: file.path,
          contextRoot: file.contextRoot,
          folderName: this.activeContextFilter.folderName,
        });
      }

      this.filteredFiles = [];
      this.selectedMentionIndex = 0;
      this.renderMentionDropdown();
      return;
    }

    // Reset filter when not in filter mode
    this.activeContextFilter = null;

    // Add MCP servers first (context-saving ones only)
    if (this.mcpService) {
      const mcpServers = this.mcpService.getContextSavingServers();

      for (const server of mcpServers) {
        if (server.name.toLowerCase().includes(searchLower)) {
          this.filteredMentionItems.push({
            type: 'mcp-server',
            name: server.name,
          });
        }
      }
    }

    // Add context folder filters (when search matches a context path folder name)
    if (contextEntries.length > 0) {
      const matchingFolders = new Set<string>();
      for (const entry of contextEntries) {
        if (entry.displayNameLower.includes(searchLower) && !matchingFolders.has(entry.displayName)) {
          matchingFolders.add(entry.displayName);
          this.filteredMentionItems.push({
            type: 'context-folder',
            name: entry.displayName,
            contextRoot: entry.contextRoot,
            folderName: entry.displayName,
          });
        }
      }
    }

    // Context path files are only shown when using @folder/ filter
    // (handled above in the isFilterSearch block)

    // Track where vault files start (after MCP servers, context folders, and context files)
    const firstVaultFileIndex = this.filteredMentionItems.length;

    // Add vault files (remaining slots up to 10 total)
    const remainingSlots = 10 - this.filteredMentionItems.length;
    if (remainingSlots > 0) {
      const allFiles = this.getCachedMarkdownFiles();
      this.filteredFiles = allFiles
        .filter(file => {
          const pathLower = file.path.toLowerCase();
          const nameLower = file.name.toLowerCase();
          return pathLower.includes(searchLower) || nameLower.includes(searchLower);
        })
        .sort((a, b) => {
          const aNameMatch = a.name.toLowerCase().startsWith(searchLower);
          const bNameMatch = b.name.toLowerCase().startsWith(searchLower);
          if (aNameMatch && !bNameMatch) return -1;
          if (!aNameMatch && bNameMatch) return 1;
          return b.stat.mtime - a.stat.mtime;
        })
        .slice(0, remainingSlots);

      // Add file items to mention items
      for (const file of this.filteredFiles) {
        this.filteredMentionItems.push({
          type: 'file',
          name: file.name,
          path: file.path,
        });
      }
    } else {
      this.filteredFiles = [];
    }

    // Default selection to first vault file if available, otherwise first item
    if (this.filteredFiles.length > 0) {
      this.selectedMentionIndex = firstVaultFileIndex;
    } else {
      this.selectedMentionIndex = 0;
    }

    this.renderMentionDropdown();
  }

  private renderMentionDropdown() {
    if (!this.mentionDropdown) {
      this.mentionDropdown = this.containerEl.createDiv({ cls: 'claudian-mention-dropdown' });
    }

    this.mentionDropdown.empty();

    if (this.filteredMentionItems.length === 0) {
      const emptyEl = this.mentionDropdown.createDiv({ cls: 'claudian-mention-empty' });
      emptyEl.setText('No matches');
    } else {
      for (let i = 0; i < this.filteredMentionItems.length; i++) {
        const item = this.filteredMentionItems[i];
        const itemEl = this.mentionDropdown.createDiv({ cls: 'claudian-mention-item' });

        if (item.type === 'mcp-server') {
          itemEl.addClass('mcp-server');
        } else if (item.type === 'context-file') {
          itemEl.addClass('context-file');
        } else if (item.type === 'context-folder') {
          itemEl.addClass('context-folder');
        }

        if (i === this.selectedMentionIndex) {
          itemEl.addClass('selected');
        }

        const iconEl = itemEl.createSpan({ cls: 'claudian-mention-icon' });
        if (item.type === 'mcp-server') {
          setIcon(iconEl, 'plug');
        } else if (item.type === 'context-file') {
          setIcon(iconEl, 'folder-open');
        } else if (item.type === 'context-folder') {
          setIcon(iconEl, 'folder');
        } else {
          setIcon(iconEl, 'file-text');
        }

        const textEl = itemEl.createSpan({ cls: 'claudian-mention-text' });

        if (item.type === 'mcp-server') {
          const nameEl = textEl.createSpan({ cls: 'claudian-mention-name' });
          nameEl.setText(`@${item.name}`);
        } else if (item.type === 'context-folder') {
          // Context folder filter: show @folderName/
          const nameEl = textEl.createSpan({ cls: 'claudian-mention-name claudian-mention-name-folder' });
          nameEl.setText(`@${item.name}/`);
        } else if (item.type === 'context-file') {
          // Context file: show relative path (subfolder/file)
          const nameEl = textEl.createSpan({ cls: 'claudian-mention-name claudian-mention-name-context' });
          nameEl.setText(item.name);
        } else {
          const pathEl = textEl.createSpan({ cls: 'claudian-mention-path' });
          pathEl.setText(item.path || item.name);
        }

        itemEl.addEventListener('click', () => {
          this.selectedMentionIndex = i;
          this.selectMentionItem();
        });

        itemEl.addEventListener('mouseenter', () => {
          this.selectedMentionIndex = i;
          this.updateMentionSelection();
        });
      }
    }

    this.mentionDropdown.addClass('visible');
  }

  private navigateMentionDropdown(direction: number) {
    const maxIndex = this.filteredMentionItems.length - 1;
    this.selectedMentionIndex = Math.max(0, Math.min(maxIndex, this.selectedMentionIndex + direction));
    this.updateMentionSelection();
  }

  private updateMentionSelection() {
    const items = this.mentionDropdown?.querySelectorAll('.claudian-mention-item');
    items?.forEach((item, index) => {
      if (index === this.selectedMentionIndex) {
        item.addClass('selected');
        (item as HTMLElement).scrollIntoView({ block: 'nearest' });
      } else {
        item.removeClass('selected');
      }
    });
  }

  private selectMentionItem() {
    if (this.filteredMentionItems.length === 0) return;

    const selectedItem = this.filteredMentionItems[this.selectedMentionIndex];
    if (!selectedItem) return;

    const text = this.inputEl.value;
    const beforeAt = text.substring(0, this.mentionStartIndex);
    const afterCursor = text.substring(this.inputEl.selectionStart || 0);

    if (selectedItem.type === 'mcp-server') {
      // MCP server mention
      const replacement = `@${selectedItem.name} `;
      this.inputEl.value = beforeAt + replacement + afterCursor;
      this.inputEl.selectionStart = this.inputEl.selectionEnd = beforeAt.length + replacement.length;

      // Add to mentioned servers and notify McpServerSelector
      this.mentionedMcpServers.add(selectedItem.name);
      this.onMcpMentionChange?.(this.mentionedMcpServers);
    } else if (selectedItem.type === 'context-folder') {
      // Context folder filter - insert @folderName/ to enable filtering
      // Don't hide dropdown, let user continue typing to filter files
      const replacement = `@${selectedItem.name}/`;
      this.inputEl.value = beforeAt + replacement + afterCursor;
      this.inputEl.selectionStart = this.inputEl.selectionEnd = beforeAt.length + replacement.length;
      this.inputEl.focus();

      // Trigger input change to refresh dropdown with filtered files
      this.handleInputChange();
      return; // Don't hide dropdown - user needs to select a file
    } else if (selectedItem.type === 'context-file') {
      // Context file mention - use absolute path, show with folder prefix
      if (selectedItem.absolutePath) {
        this.attachedFiles.add(selectedItem.absolutePath);
      }

      // Format as @folderName/relativePath to indicate it's from a context path
      const displayName = selectedItem.folderName
        ? `@${selectedItem.folderName}/${selectedItem.name}`
        : `@${selectedItem.name}`;
      const replacement = `${displayName} `;
      this.inputEl.value = beforeAt + replacement + afterCursor;
      this.inputEl.selectionStart = this.inputEl.selectionEnd = beforeAt.length + replacement.length;
      this.updateFileIndicator();
    } else {
      // Vault file mention
      const file = this.filteredFiles.find(f => f.path === selectedItem.path);
      if (file) {
        const normalizedPath = this.normalizePathForVault(file.path);
        if (normalizedPath) {
          this.attachedFiles.add(normalizedPath);
        }
      }

      const replacement = `@${selectedItem.name} `;
      this.inputEl.value = beforeAt + replacement + afterCursor;
      this.inputEl.selectionStart = this.inputEl.selectionEnd = beforeAt.length + replacement.length;
      this.updateFileIndicator();
    }

    this.hideMentionDropdown();
    this.inputEl.focus();
  }
}
