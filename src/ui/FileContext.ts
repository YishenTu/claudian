import { App, TFile, setIcon, EventRef } from 'obsidian';
import { createHash } from 'crypto';
import { getVaultPath } from '../utils';

/**
 * Hash state for tracking file content changes
 */
interface FileHashState {
  originalHash: string | null;  // Content before Claude's first edit (null if new file)
  postEditHash: string;         // Content after Claude's last edit
}

/**
 * Callbacks for file context interactions
 */
export interface FileContextCallbacks {
  getExcludedTags: () => string[];
  onFileOpen: (path: string) => Promise<void>;
}

/**
 * Manages file context UI components:
 * - Attached files indicator
 * - Edited files indicator
 * - @ mention dropdown
 */
export class FileContextManager {
  private app: App;
  private callbacks: FileContextCallbacks;

  // DOM elements
  private containerEl: HTMLElement;
  private fileIndicatorEl: HTMLElement;
  private editedFilesIndicatorEl: HTMLElement;
  private mentionDropdown: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement;

  // State
  private attachedFiles: Set<string> = new Set();
  private lastSentFiles: Set<string> = new Set();
  private editedFilesThisSession: Set<string> = new Set();
  private sessionStarted = false;

  // Hash tracking for edited files
  private editedFileHashes: Map<string, FileHashState> = new Map();
  private filesBeingEdited: Set<string> = new Set();

  // Vault event listeners
  private deleteEventRef: EventRef | null = null;
  private renameEventRef: EventRef | null = null;
  private modifyEventRef: EventRef | null = null;

  // Mention dropdown state
  private mentionStartIndex = -1;
  private selectedMentionIndex = 0;
  private filteredFiles: TFile[] = [];

  // File cache
  private cachedMarkdownFiles: TFile[] = [];
  private filesCacheDirty = true;

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

    // Create indicator elements (insert before existing content to stay above input)
    const firstChild = this.containerEl.firstChild;
    this.editedFilesIndicatorEl = this.containerEl.createDiv({ cls: 'claudian-edited-files-indicator' });
    this.fileIndicatorEl = this.containerEl.createDiv({ cls: 'claudian-file-indicator' });
    if (firstChild) {
      this.containerEl.insertBefore(this.editedFilesIndicatorEl, firstChild);
      this.containerEl.insertBefore(this.fileIndicatorEl, firstChild);
    }

    // Register vault event listeners for file deletion/rename/modify detection
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

  // ============================================
  // Public API
  // ============================================

  /**
   * Get the set of currently attached files
   */
  getAttachedFiles(): Set<string> {
    return this.attachedFiles;
  }

  /**
   * Check if attached files have changed since last sent
   */
  hasFilesChanged(): boolean {
    const currentFiles = Array.from(this.attachedFiles);
    if (currentFiles.length !== this.lastSentFiles.size) return true;
    for (const file of currentFiles) {
      if (!this.lastSentFiles.has(file)) return true;
    }
    return false;
  }

  /**
   * Mark files as sent (call after sending a message)
   */
  markFilesSent() {
    this.lastSentFiles = new Set(this.attachedFiles);
  }

  /**
   * Check if session has started
   */
  isSessionStarted(): boolean {
    return this.sessionStarted;
  }

  /**
   * Mark session as started
   */
  startSession() {
    this.sessionStarted = true;
  }

  /**
   * Reset for a new conversation
   */
  resetForNewConversation() {
    this.sessionStarted = false;
    this.lastSentFiles.clear();
    this.attachedFiles.clear();
    this.clearEditedFiles();
  }

  /**
   * Reset for loading an existing conversation
   */
  resetForLoadedConversation(hasMessages: boolean) {
    this.lastSentFiles.clear();
    this.attachedFiles.clear();
    this.sessionStarted = hasMessages;
    this.clearEditedFiles();
  }

  /**
   * Auto-attach currently focused file (for new sessions)
   */
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

  /**
   * Handle file open event
   */
  handleFileOpen(file: TFile) {
    const normalizedPath = this.normalizePathForVault(file.path);
    if (!normalizedPath) return;

    // Dismiss edited indicator when file is focused
    if (this.isFileEdited(normalizedPath)) {
      this.dismissEditedFile(normalizedPath);
    }

    // Update attachment before session starts (skip if file has excluded tags)
    if (!this.sessionStarted) {
      this.attachedFiles.clear();
      if (!this.hasExcludedTag(file)) {
        this.attachedFiles.add(normalizedPath);
      }
      this.updateFileIndicator();
    }

    // Notify callbacks
    this.callbacks.onFileOpen(normalizedPath);
  }

  /**
   * Mark a file as being edited (called from PreToolUse hook)
   * Captures original hash before Claude edits the file
   */
  async markFileBeingEdited(toolName: string, toolInput: Record<string, unknown>) {
    if (!['Write', 'Edit', 'NotebookEdit'].includes(toolName)) return;

    const rawPath = (toolInput?.file_path as string) || (toolInput?.notebook_path as string);
    const path = this.normalizePathForVault(rawPath);
    if (!path) return;

    const wasBeingEdited = this.filesBeingEdited.has(path);
    this.filesBeingEdited.add(path);

    // BUG FIX #1: Always refresh baseline when a new edit sequence starts
    // (even if we tracked this file earlier in the session)
    if (!wasBeingEdited) {
      const originalHash = await this.computeFileHash(path);  // null if file doesn't exist
      this.editedFileHashes.set(path, { originalHash, postEditHash: '' });
    }
  }

  /**
   * Track a file as edited (called from PostToolUse hook)
   */
  async trackEditedFile(toolName: string | undefined, toolInput: Record<string, unknown> | undefined, isError: boolean) {
    // Only track Write, Edit, NotebookEdit tools
    if (!toolName || !['Write', 'Edit', 'NotebookEdit'].includes(toolName)) return;

    // Extract file path from tool input
    const rawPath = (toolInput?.file_path as string) || (toolInput?.notebook_path as string);
    const filePath = this.normalizePathForVault(rawPath);
    if (!filePath) return;

    if (isError) {
      // BUG FIX #4: Unmark AFTER error check to avoid race window
      this.filesBeingEdited.delete(filePath);
      // Clean up hash state if edit failed and file wasn't previously tracked
      if (!this.editedFilesThisSession.has(filePath)) {
        this.editedFileHashes.delete(filePath);
      }
      return;
    }

    // BUG FIX #4: Compute hash BEFORE unmarking to prevent race with modify events
    // Store post-edit hash while still marked as being edited
    const postEditHash = await this.computeFileHash(filePath);
    const existing = this.editedFileHashes.get(filePath);

    // NOW unmark as being edited (after hash computation)
    this.filesBeingEdited.delete(filePath);

    if (postEditHash) {
      // Check if content is back to original (net effect = no change)
      if (existing?.originalHash && postEditHash === existing.originalHash) {
        // File reverted to original - remove tracking
        this.editedFilesThisSession.delete(filePath);
        this.editedFileHashes.delete(filePath);
        this.updateEditedFilesIndicator();
        this.updateFileIndicator();
        return;
      }

      // Update post-edit hash
      this.editedFileHashes.set(filePath, {
        originalHash: existing?.originalHash ?? null,
        postEditHash
      });
    }

    this.editedFilesThisSession.add(filePath);
    this.updateEditedFilesIndicator();
    // Re-render attachment chips to show edited border if file is attached
    this.updateFileIndicator();
  }

  /**
   * BUG FIX #5: Clean up state for a file that was marked for editing but permission was denied
   * Called when Safe mode denies a tool execution to prevent dirty state
   */
  cancelFileEdit(toolName: string, toolInput: Record<string, unknown>) {
    if (!['Write', 'Edit', 'NotebookEdit'].includes(toolName)) return;

    const rawPath = (toolInput?.file_path as string) || (toolInput?.notebook_path as string);
    const path = this.normalizePathForVault(rawPath);
    if (!path) return;

    // Remove from filesBeingEdited
    this.filesBeingEdited.delete(path);

    // Clean up hash state if file wasn't previously tracked as edited
    if (!this.editedFilesThisSession.has(path)) {
      this.editedFileHashes.delete(path);
    }
  }

  /**
   * Mark files cache as dirty (call on vault changes)
   */
  markFilesCacheDirty() {
    this.filesCacheDirty = true;
  }

  /**
   * Handle input changes to detect @ mentions
   */
  handleInputChange() {
    const text = this.inputEl.value;
    const cursorPos = this.inputEl.selectionStart || 0;

    // Find the last @ before cursor
    const textBeforeCursor = text.substring(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      this.hideMentionDropdown();
      return;
    }

    // Check if @ is at start or after whitespace (valid trigger)
    const charBeforeAt = lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : ' ';
    if (!/\s/.test(charBeforeAt) && lastAtIndex !== 0) {
      this.hideMentionDropdown();
      return;
    }

    // Extract search text after @
    const searchText = textBeforeCursor.substring(lastAtIndex + 1);

    // Check if search text contains newlines (closed mention)
    if (/[\n]/.test(searchText)) {
      this.hideMentionDropdown();
      return;
    }

    this.mentionStartIndex = lastAtIndex;
    this.showMentionDropdown(searchText);
  }

  /**
   * Handle keyboard navigation in mention dropdown
   * Returns true if the event was handled
   */
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

  /**
   * Check if mention dropdown is visible
   */
  isMentionDropdownVisible(): boolean {
    return this.mentionDropdown?.hasClass('visible') ?? false;
  }

  /**
   * Hide mention dropdown (e.g., on click outside)
   */
  hideMentionDropdown() {
    this.mentionDropdown?.removeClass('visible');
    this.mentionStartIndex = -1;
  }

  /**
   * Check if dropdown contains the given element
   */
  containsElement(el: Node): boolean {
    return this.mentionDropdown?.contains(el) ?? false;
  }

  /**
   * Clean up event listeners (call on view close)
   */
  destroy() {
    if (this.deleteEventRef) this.app.vault.offref(this.deleteEventRef);
    if (this.renameEventRef) this.app.vault.offref(this.renameEventRef);
    if (this.modifyEventRef) this.app.vault.offref(this.modifyEventRef);
  }

  // ============================================
  // Path Normalization
  // ============================================

  /**
   * Normalize a file path to be vault-relative with forward slashes
   */
  normalizePathForVault(rawPath: string | undefined | null): string | null {
    if (!rawPath) return null;

    // Normalize separators first
    const unixPath = rawPath.replace(/\\/g, '/');
    const vaultPath = getVaultPath(this.app);

    if (vaultPath) {
      const normalizedVault = vaultPath.replace(/\\/g, '/').replace(/\/+$/, '');
      if (unixPath.startsWith(normalizedVault)) {
        const relative = unixPath.slice(normalizedVault.length).replace(/^\/+/, '');
        if (relative) {
          return relative;
        }
      }
    }

    return unixPath.replace(/^\/+/, '');
  }

  // ============================================
  // Private: File Indicator
  // ============================================

  private updateFileIndicator() {
    this.fileIndicatorEl.empty();

    if (this.attachedFiles.size === 0) {
      this.fileIndicatorEl.style.display = 'none';
      this.updateEditedFilesIndicator();
      return;
    }

    this.fileIndicatorEl.style.display = 'flex';

    for (const path of this.attachedFiles) {
      this.renderFileChip(path, () => {
        this.attachedFiles.delete(path);
        this.updateFileIndicator();
      });
    }

    // Keep edited files indicator in sync with attachment changes
    this.updateEditedFilesIndicator();
  }

  private renderFileChip(path: string, onRemove: () => void) {
    const chipEl = this.fileIndicatorEl.createDiv({ cls: 'claudian-file-chip' });

    // Add edited class if file was edited this session
    if (this.isFileEdited(path)) {
      chipEl.addClass('claudian-file-chip-edited');
    }

    const iconEl = chipEl.createSpan({ cls: 'claudian-file-chip-icon' });
    setIcon(iconEl, 'file-text');

    // Extract filename from path
    const filename = path.split('/').pop() || path;
    const nameEl = chipEl.createSpan({ cls: 'claudian-file-chip-name' });
    nameEl.setText(filename);
    nameEl.setAttribute('title', path); // Show full path on hover

    const removeEl = chipEl.createSpan({ cls: 'claudian-file-chip-remove' });
    removeEl.setText('\u00D7'); // × symbol
    removeEl.setAttribute('aria-label', 'Remove');

    // Click chip to open file (but not remove button)
    chipEl.addEventListener('click', async (e) => {
      if ((e.target as HTMLElement).closest('.claudian-file-chip-remove')) return;
      await this.openFileFromChip(path);
    });

    removeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove();
    });
  }

  private async openFileFromChip(path: string) {
    const normalizedPath = this.normalizePathForVault(path);
    if (!normalizedPath) return;

    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf('tab').openFile(file);
    }
  }

  // ============================================
  // Private: Edited Files
  // ============================================

  private clearEditedFiles() {
    this.editedFilesThisSession.clear();
    this.editedFileHashes.clear();
    this.filesBeingEdited.clear();
    this.updateFileIndicator();
  }

  private dismissEditedFile(path: string) {
    const normalizedPath = this.normalizePathForVault(path);
    if (!normalizedPath) return;

    // BUG FIX #3: Don't dismiss if Claude is currently editing this file
    // This prevents clearing hash state prematurely when user opens file during edit
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

  /**
   * Compute a strong hash of file content for change detection
   * Uses SHA-256 over the full content
   */
  private async computeFileHash(path: string): Promise<string | null> {
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return null;
      const content = await this.app.vault.read(file);
      return await this.computeContentHash(content);
    } catch {
      return null;  // File doesn't exist
    }
  }

  /**
   * Hash full content with SHA-256 (WebCrypto when available, Node crypto fallback)
   */
  private async computeContentHash(content: string): Promise<string> {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoded = new TextEncoder().encode(content);
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Fallback for environments without WebCrypto
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Handle file deletion - remove from tracking
   */
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

  /**
   * Handle file rename - update path in tracking
   */
  private handleFileRenamed(oldPath: string, newPath: string) {
    const normalizedOld = this.normalizePathForVault(oldPath);
    const normalizedNew = this.normalizePathForVault(newPath);
    if (!normalizedOld) return;

    let needsUpdate = false;

    // BUG FIX #2: Also update attachedFiles when file is renamed
    if (this.attachedFiles.has(normalizedOld)) {
      this.attachedFiles.delete(normalizedOld);
      if (normalizedNew) {
        this.attachedFiles.add(normalizedNew);
      }
      needsUpdate = true;
    }

    // Update edited files tracking
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

    // Update filesBeingEdited if applicable
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

  /**
   * Handle file modification - check if content reverted to original
   */
  private async handleFileModified(file: TFile) {
    const normalized = this.normalizePathForVault(file.path);
    if (!normalized) return;

    // Ignore if Claude is currently editing this file
    if (this.filesBeingEdited.has(normalized)) return;

    // Ignore if not a tracked edited file
    if (!this.editedFilesThisSession.has(normalized)) return;

    const hashState = this.editedFileHashes.get(normalized);
    if (!hashState) return;

    const currentHash = await this.computeFileHash(normalized);
    if (!currentHash) return;

    // Only remove chip if content reverted to ORIGINAL
    // This avoids race condition with Claude's subsequent edits
    if (hashState.originalHash && currentHash === hashState.originalHash) {
      // Content reverted to original - remove tracking
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

    if (!this.shouldShowEditedFilesSection()) {
      this.editedFilesIndicatorEl.style.display = 'none';
      return;
    }

    this.editedFilesIndicatorEl.style.display = 'flex';

    // Add label
    const label = this.editedFilesIndicatorEl.createSpan({ cls: 'claudian-edited-label' });
    label.setText('Edited:');

    // Render chips for non-attached edited files
    for (const path of this.getNonAttachedEditedFiles()) {
      this.renderEditedFileChip(path);
    }
  }

  private renderEditedFileChip(path: string) {
    const chipEl = this.editedFilesIndicatorEl.createDiv({ cls: 'claudian-file-chip claudian-file-chip-edited' });

    const iconEl = chipEl.createSpan({ cls: 'claudian-file-chip-icon' });
    setIcon(iconEl, 'file-text');

    // Extract filename from path
    const filename = path.split('/').pop() || path;
    const nameEl = chipEl.createSpan({ cls: 'claudian-file-chip-name' });
    nameEl.setText(filename);
    nameEl.setAttribute('title', path);

    // Click to open
    chipEl.addEventListener('click', async () => {
      await this.openFileFromChip(path);
    });
  }

  // ============================================
  // Private: @ Mention Dropdown
  // ============================================

  private getCachedMarkdownFiles(): TFile[] {
    if (this.filesCacheDirty || this.cachedMarkdownFiles.length === 0) {
      this.cachedMarkdownFiles = this.app.vault.getMarkdownFiles();
      this.filesCacheDirty = false;
    }
    return this.cachedMarkdownFiles;
  }

  private hasExcludedTag(file: TFile): boolean {
    const excludedTags = this.callbacks.getExcludedTags();
    if (excludedTags.length === 0) return false;

    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return false;

    // Collect all tags from the file
    const fileTags: string[] = [];

    // Frontmatter tags (cache.frontmatter?.tags)
    if (cache.frontmatter?.tags) {
      const fmTags = cache.frontmatter.tags;
      if (Array.isArray(fmTags)) {
        fileTags.push(...fmTags.map((t: string) => t.replace(/^#/, '')));
      } else if (typeof fmTags === 'string') {
        fileTags.push(fmTags.replace(/^#/, ''));
      }
    }

    // Inline tags (cache.tags)
    if (cache.tags) {
      fileTags.push(...cache.tags.map(t => t.tag.replace(/^#/, '')));
    }

    // Check if any file tag matches an excluded tag
    return fileTags.some(tag => excludedTags.includes(tag));
  }

  private showMentionDropdown(searchText: string) {
    // Get all markdown files (cached)
    const allFiles = this.getCachedMarkdownFiles();

    // Filter by search text
    const searchLower = searchText.toLowerCase();
    this.filteredFiles = allFiles
      .filter(file => {
        const pathLower = file.path.toLowerCase();
        const nameLower = file.name.toLowerCase();
        return pathLower.includes(searchLower) || nameLower.includes(searchLower);
      })
      .sort((a, b) => {
        // Prioritize name matches over path matches
        const aNameMatch = a.name.toLowerCase().startsWith(searchLower);
        const bNameMatch = b.name.toLowerCase().startsWith(searchLower);
        if (aNameMatch && !bNameMatch) return -1;
        if (!aNameMatch && bNameMatch) return 1;
        // Then sort by modification time (recent first)
        return b.stat.mtime - a.stat.mtime;
      })
      .slice(0, 10); // Limit to 10 results

    this.selectedMentionIndex = 0;
    this.renderMentionDropdown();
  }

  private renderMentionDropdown() {
    if (!this.mentionDropdown) {
      this.mentionDropdown = this.containerEl.createDiv({ cls: 'claudian-mention-dropdown' });
    }

    this.mentionDropdown.empty();

    if (this.filteredFiles.length === 0) {
      const emptyEl = this.mentionDropdown.createDiv({ cls: 'claudian-mention-empty' });
      emptyEl.setText('No matching files');
    } else {
      for (let i = 0; i < this.filteredFiles.length; i++) {
        const file = this.filteredFiles[i];
        const itemEl = this.mentionDropdown.createDiv({ cls: 'claudian-mention-item' });

        if (i === this.selectedMentionIndex) {
          itemEl.addClass('selected');
        }

        const iconEl = itemEl.createSpan({ cls: 'claudian-mention-icon' });
        setIcon(iconEl, 'file-text');

        const pathEl = itemEl.createSpan({ cls: 'claudian-mention-path' });
        pathEl.setText(file.path);

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
    const maxIndex = this.filteredFiles.length - 1;
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
    if (this.filteredFiles.length === 0) return;

    const selectedFile = this.filteredFiles[this.selectedMentionIndex];
    if (!selectedFile) return;

    // Add to attached files
    const normalizedPath = this.normalizePathForVault(selectedFile.path);
    if (normalizedPath) {
      this.attachedFiles.add(normalizedPath);
    }

    // Replace @search text with @filename in input
    const text = this.inputEl.value;
    const beforeAt = text.substring(0, this.mentionStartIndex);
    const afterCursor = text.substring(this.inputEl.selectionStart || 0);
    const filename = selectedFile.name;
    const replacement = `@${filename} `;
    this.inputEl.value = beforeAt + replacement + afterCursor;
    this.inputEl.selectionStart = this.inputEl.selectionEnd = beforeAt.length + replacement.length;

    this.hideMentionDropdown();
    this.updateFileIndicator();
    this.inputEl.focus();
  }
}
