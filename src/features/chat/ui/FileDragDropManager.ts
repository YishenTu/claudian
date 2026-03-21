/**
 * Claudian - File Drag and Drop Manager
 *
 * Handles drag-and-drop of files from Obsidian's file tree/explorer into the chat view.
 * Provides visual feedback during drag operations and integrates with FileContextManager
 * to add files to the current session.
 */

import type { App } from 'obsidian';

import { t } from '../../../i18n';

export interface FileDragDropCallbacks {
  /** Called when files are dropped and ready to be added to context */
  onFilesDropped: (filePaths: string[]) => void;
}

interface FileLike {
  path: string;
  basename?: string;
}

export class FileDragDropManager {
  private app: App;
  private containerEl: HTMLElement;
  private callbacks: FileDragDropCallbacks;
  private dropOverlay: HTMLElement | null = null;
  private dropZoneEl: HTMLElement | null = null;
  private dragEnterCount = 0;
  private readonly dragEnterHandler = (e: Event) => this.handleDragEnter(e as DragEvent);
  private readonly dragOverHandler = (e: Event) => this.handleDragOver(e as DragEvent);
  private readonly dragLeaveHandler = (e: Event) => this.handleDragLeave(e as DragEvent);
  private readonly dropHandler = (e: Event) => this.handleDrop(e as DragEvent);

  constructor(
    app: App,
    containerEl: HTMLElement,
    callbacks: FileDragDropCallbacks
  ) {
    this.app = app;
    this.containerEl = containerEl;
    this.callbacks = callbacks;

    this.setupDragAndDrop();
  }

  private setupDragAndDrop() {
    this.createDropOverlay();
    this.attachEventListeners();
  }

  private createDropOverlay() {
    const inputWrapper = this.containerEl.querySelector('.claudian-input-wrapper') as HTMLElement;
    if (!inputWrapper) return;

    this.dropOverlay = inputWrapper.createDiv({ cls: 'claudian-file-drop-overlay' });
    const dropContent = this.dropOverlay.createDiv({ cls: 'claudian-file-drop-content' });

    // Create upload icon SVG
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '32');
    svg.setAttribute('height', '32');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4');
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', '17 8 12 3 7 8');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '12');
    line.setAttribute('y1', '3');
    line.setAttribute('x2', '12');
    line.setAttribute('y2', '15');

    svg.appendChild(path);
    svg.appendChild(polyline);
    svg.appendChild(line);
    dropContent.appendChild(svg);
    dropContent.createSpan({ text: t('chat.fileDrop.overlay') });
  }

  private attachEventListeners() {
    const inputWrapper = this.containerEl.querySelector('.claudian-input-wrapper') as HTMLElement;
    if (!inputWrapper) return;

    this.dropZoneEl = inputWrapper;
    inputWrapper.addEventListener('dragenter', this.dragEnterHandler);
    inputWrapper.addEventListener('dragover', this.dragOverHandler);
    inputWrapper.addEventListener('dragleave', this.dragLeaveHandler);
    inputWrapper.addEventListener('drop', this.dropHandler);
  }

  private handleDragEnter(e: DragEvent) {
    if (!this.isObsidianFileDrag(e.dataTransfer)) return;

    e.preventDefault();
    e.stopPropagation();
    this.dragEnterCount++;
    this.dropOverlay?.addClass('visible');
  }

  private handleDragOver(e: DragEvent) {
    if (!this.isObsidianFileDrag(e.dataTransfer)) return;

    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  private handleDragLeave(e: DragEvent) {
    if (!this.isObsidianFileDrag(e.dataTransfer)) return;

    e.preventDefault();
    e.stopPropagation();

    this.dragEnterCount = Math.max(0, this.dragEnterCount - 1);

    if (this.dragEnterCount === 0) {
      const inputWrapper = this.containerEl.querySelector('.claudian-input-wrapper');
      if (!inputWrapper) {
        this.dropOverlay?.removeClass('visible');
        return;
      }

      const rect = inputWrapper.getBoundingClientRect();
      if (
        e.clientX <= rect.left ||
        e.clientX >= rect.right ||
        e.clientY <= rect.top ||
        e.clientY >= rect.bottom
      ) {
        this.dropOverlay?.removeClass('visible');
      }
    }
  }

  private handleDrop(e: DragEvent) {
    const dataTransfer = e.dataTransfer;
    if (!dataTransfer) return;

    this.dragEnterCount = 0;
    this.dropOverlay?.removeClass('visible');

    // Try to get files from Obsidian's file tree drag
    const filePaths = this.extractFilesFromDrop(dataTransfer);
    if (filePaths.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    this.callbacks.onFilesDropped(filePaths);
  }

  /**
   * Extracts file vault paths from a drop event.
   * Prefers Obsidian's internal drag manager (reliable TFile references),
   * then falls back to parsing dataTransfer payloads.
   */
  private extractFilesFromDrop(dataTransfer: DataTransfer): string[] {
    const byPath = new Set<string>();

    // Primary: Obsidian's dragManager holds the actual TFile being dragged.
    // dataTransfer payloads from the file tree often contain only display names
    // (e.g. [[filename]]) which may fail vault resolution.
    const draggable = (this.app as any).dragManager?.draggable;
    if (draggable) {
      if (draggable.type === 'file' && typeof draggable.file?.path === 'string') {
        byPath.add(draggable.file.path);
      } else if (draggable.type === 'files' && Array.isArray(draggable.files)) {
        for (const file of draggable.files) {
          if (typeof file?.path === 'string') byPath.add(file.path);
        }
      }
    }

    if (byPath.size > 0) return Array.from(byPath);

    // Fallback: parse text payloads (handles drops from external sources or
    // Obsidian versions that set dataTransfer data directly).
    const payloads = [
      dataTransfer.getData('text/obsidian-markdown'),
      dataTransfer.getData('text/plain'),
    ];

    for (const payload of payloads) {
      if (!payload) continue;
      const paths = this.parseObsidianFileDrop(payload);
      for (const path of paths) {
        byPath.add(path);
      }
    }

    return Array.from(byPath);
  }

  /**
   * Parses Obsidian's markdown data transfer format.
   * Format: 'markdown: [[file1.md]]\n[[file2.md]]' or just filepath
   */
  private parseObsidianFileDrop(data: string): string[] {
    const files: string[] = [];

    // Remove 'markdown: ' prefix if present
    const content = data.replace(/^markdown:\s*/, '');

    // Extract wikilinks: [[path/to/file]]
    const wikiLinkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match: RegExpExecArray | null;

    while ((match = wikiLinkPattern.exec(content)) !== null) {
      const filePath = match[1];
      const file = this.resolveFileFromPath(filePath);
      if (file) {
        files.push(file.path);
      }
    }

    // Extract markdown links: [label](path/to/file.md) or obsidian://open?...&file=
    const markdownLinkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
    while ((match = markdownLinkPattern.exec(content)) !== null) {
      const resolvedPath = this.extractPathFromUrlLike(match[1]);
      if (!resolvedPath) continue;
      const file = this.resolveFileFromPath(resolvedPath);
      if (file) {
        files.push(file.path);
      }
    }

    // If no wikilinks found, treat the entire content as a file path
    if (files.length === 0) {
      const lineCandidates = content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0);

      if (lineCandidates.length === 0) {
        lineCandidates.push(content.trim());
      }

      for (const candidate of lineCandidates) {
        const file = this.resolveFileFromPath(candidate);
        if (file) {
          files.push(file.path);
        }
      }
    }

    return files;
  }

  private extractPathFromUrlLike(raw: string): string | null {
    const trimmed = raw.trim().replace(/^<|>$/g, '');
    if (!trimmed) return null;

    if (!trimmed.startsWith('obsidian://')) {
      return trimmed;
    }

    try {
      const url = new URL(trimmed);
      if (url.hostname !== 'open') return null;
      const file = url.searchParams.get('file');
      return file || null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves a file path string to a TFile object.
   * Tries multiple resolution strategies:
   * 1. Direct path lookup
   * 2. Vault's getFirstLinkpathDest (for wikilink resolution)
   * 3. Search by basename (fallback)
   */
  private resolveFileFromPath(filePath: string): FileLike | null {
    if (!filePath) return null;

    // Strategy 1: Direct path
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (this.isFileLike(file)) return file;

    // Strategy 2: Use Obsidian's link resolution
    const resolved = this.app.metadataCache.getFirstLinkpathDest(filePath, '');
    if (this.isFileLike(resolved)) return resolved;

    // Strategy 3: Search by basename across all vault files
    const basename = filePath.split('/').pop();
    if (basename) {
      const found = this.app.vault.getFiles().find(f => f.basename === basename);
      if (found) return found;
    }

    return null;
  }

  private isObsidianFileDrag(dataTransfer: DataTransfer | null | undefined): boolean {
    if (!dataTransfer) return false;

    // Obsidian's drag manager is the authoritative source for file drags from the file explorer.
    const draggable = (this.app as any).dragManager?.draggable;
    if (draggable?.type === 'file' || draggable?.type === 'files') {
      return true;
    }

    const types = Array.from(dataTransfer.types || []);

    if (types.includes('text/obsidian-markdown')) {
      return true;
    }

    // Obsidian file explorer drag can expose text/plain payloads without Files,
    // but only when dragManager.draggable is absent (older Obsidian versions).
    // Require the absence of 'Files' AND 'text/uri-list' to avoid matching
    // URL drags, bookmark drags, and plain-text drags from external apps.
    if (
      types.includes('text/plain') &&
      !types.includes('Files') &&
      !types.includes('text/uri-list')
    ) {
      return true;
    }

    return false;
  }

  private isFileLike(value: unknown): value is FileLike {
    if (!value || typeof value !== 'object') return false;
    const file = value as Record<string, unknown>;
    return typeof file.path === 'string' && !Array.isArray(file.children);
  }

  destroy() {
    this.dragEnterCount = 0;
    if (this.dropZoneEl) {
      this.dropZoneEl.removeEventListener('dragenter', this.dragEnterHandler);
      this.dropZoneEl.removeEventListener('dragover', this.dragOverHandler);
      this.dropZoneEl.removeEventListener('dragleave', this.dragLeaveHandler);
      this.dropZoneEl.removeEventListener('drop', this.dropHandler);
      this.dropZoneEl = null;
    }
    if (this.dropOverlay) {
      this.dropOverlay.remove();
      this.dropOverlay = null;
    }
  }
}
