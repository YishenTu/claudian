/**
 * Claudian - Image context manager
 *
 * Manages image attachments via drag/drop, paste, and file path detection.
 */

import * as fs from 'fs';
import type { App } from 'obsidian';
import { Notice, TFile } from 'obsidian';
import * as path from 'path';

import { saveImageToCache } from '../../core/images/imageCache';
import type { ImageAttachment, ImageMediaType } from '../../core/types';
import { getVaultPath, isPathWithinVault, normalizePathForFilesystem } from '../../utils/path';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, ImageMediaType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Callbacks for image context interactions. */
export interface ImageContextCallbacks {
  onImagesChanged: () => void;
  getMediaFolder?: () => string;
}

/** Manages image attachments via drag/drop, paste, and file path detection. */
export class ImageContextManager {
  private app: App;
  private callbacks: ImageContextCallbacks;
  private containerEl: HTMLElement;
  private imagePreviewEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private dropOverlay: HTMLElement | null = null;
  private attachedImages: Map<string, ImageAttachment> = new Map();

  constructor(
    app: App,
    containerEl: HTMLElement,
    inputEl: HTMLTextAreaElement,
    callbacks: ImageContextCallbacks
  ) {
    this.app = app;
    this.containerEl = containerEl;
    this.inputEl = inputEl;
    this.callbacks = callbacks;

    const fileIndicator = this.containerEl.querySelector('.claudian-file-indicator');
    this.imagePreviewEl = this.containerEl.createDiv({ cls: 'claudian-image-preview' });
    if (fileIndicator) {
      this.containerEl.insertBefore(this.imagePreviewEl, fileIndicator);
    }

    this.setupDragAndDrop();
    this.setupPasteHandler();
  }

  getAttachedImages(): ImageAttachment[] {
    return Array.from(this.attachedImages.values());
  }

  hasImages(): boolean {
    return this.attachedImages.size > 0;
  }

  clearImages() {
    this.attachedImages.clear();
    this.updateImagePreview();
    this.callbacks.onImagesChanged();
  }

  /** Sets images directly (used for queued messages). */
  setImages(images: ImageAttachment[]) {
    this.attachedImages.clear();
    for (const image of images) {
      this.attachedImages.set(image.id, image);
    }
    this.updateImagePreview();
    this.callbacks.onImagesChanged();
  }

  /** Adds an image from a file path. Returns true if successful. */
  async addImageFromPath(imagePath: string): Promise<boolean> {
    try {
      const result = await this.loadImageFromPath(imagePath);
      if (result) {
        this.attachedImages.set(result.id, result);
        this.updateImagePreview();
        this.callbacks.onImagesChanged();
        return true;
      }
      this.notifyImageError(`Unable to load image from path: ${imagePath}`);
    } catch (error) {
      this.notifyImageError(`Failed to load image from path: ${imagePath}`, error);
    }
    return false;
  }

  /** Extracts an image path from text if present. */
  extractImagePath(text: string): string | null {
    const info = this.extractImagePathInfo(text);
    return info ? info.normalized : null;
  }

  /** Handles potential image path in message text. Returns cleaned text if image was loaded. */
  async handleImagePathInText(text: string): Promise<{ text: string; imageLoaded: boolean }> {
    const info = this.extractImagePathInfo(text);
    if (!info) {
      return { text, imageLoaded: false };
    }

    const loaded = await this.addImageFromPath(info.normalized);
    if (loaded) {
      const cleanedText = text
        .replace(info.raw, '')
        .replace(info.normalized, '')
        .replace(/["']\s*["']/g, '')
        .trim();
      return { text: cleanedText, imageLoaded: true };
    }

    return { text, imageLoaded: false };
  }

  private extractImagePathInfo(text: string): { raw: string; normalized: string } | null {
    const markdownMatch = text.match(/!\[[^\]]*]\(([^)]+)\)/);
    if (markdownMatch && markdownMatch[1]) {
      const markdownCandidate = this.extractMarkdownImagePath(text);
      const normalizedMarkdown = this.normalizeCandidatePath(markdownCandidate);
      if (normalizedMarkdown) {
        return { raw: markdownMatch[1], normalized: normalizedMarkdown };
      }
    }

    const htmlCandidate = this.extractHtmlImagePath(text);
    const normalizedHtml = this.normalizeCandidatePath(htmlCandidate);
    if (htmlCandidate && normalizedHtml) {
      return { raw: htmlCandidate, normalized: normalizedHtml };
    }

    const fileUrlPattern = /file:\/\/[^\s"'<>()[\]]+/gi;
    let sanitizedText = text;
    const fileMatches = text.match(fileUrlPattern) || [];
    for (const raw of fileMatches) {
      const normalized = this.normalizeCandidatePath(raw);
      if (normalized) {
        return { raw, normalized };
      }
      sanitizedText = sanitizedText.replace(raw, ' ');
    }

    const tokenPattern = /[^\s"'<>()[\]]+?\.(?:jpe?g|png|gif|webp)\b/gi;
    const matches = sanitizedText.match(tokenPattern) || [];

    for (const raw of matches) {
      const normalized = this.normalizeCandidatePath(raw);
      if (normalized) {
        return { raw, normalized };
      }
    }

    return null;
  }

  private setupDragAndDrop() {
    const inputWrapper = this.containerEl.querySelector('.claudian-input-wrapper') as HTMLElement;
    if (!inputWrapper) return;

    this.dropOverlay = inputWrapper.createDiv({ cls: 'claudian-drop-overlay' });
    const dropContent = this.dropOverlay.createDiv({ cls: 'claudian-drop-content' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '32');
    svg.setAttribute('height', '32');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4');
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', '17 8 12 3 7 8');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '12');
    line.setAttribute('y1', '3');
    line.setAttribute('x2', '12');
    line.setAttribute('y2', '15');
    svg.appendChild(pathEl);
    svg.appendChild(polyline);
    svg.appendChild(line);
    dropContent.appendChild(svg);
    dropContent.createSpan({ text: 'Drop image here' });

    const dropZone = inputWrapper;

    dropZone.addEventListener('dragenter', (e) => this.handleDragEnter(e as DragEvent));
    dropZone.addEventListener('dragover', (e) => this.handleDragOver(e as DragEvent));
    dropZone.addEventListener('dragleave', (e) => this.handleDragLeave(e as DragEvent));
    dropZone.addEventListener('drop', (e) => this.handleDrop(e as DragEvent));
  }

  private handleDragEnter(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (e.dataTransfer?.types.includes('Files')) {
      this.dropOverlay?.addClass('visible');
    }
  }

  private handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  private handleDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();

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

  private async handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.dropOverlay?.removeClass('visible');

    const files = e.dataTransfer?.files;
    if (!files) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (this.isImageFile(file)) {
        await this.addImageFromFile(file, 'drop');
      }
    }
  }

  private setupPasteHandler() {
    this.inputEl.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            await this.addImageFromFile(file, 'paste');
          }
          return;
        }
      }
    });
  }

  private isImageFile(file: File): boolean {
    return file.type.startsWith('image/') && this.getMediaType(file.name) !== null;
  }

  private getMediaType(filename: string): ImageMediaType | null {
    const ext = path.extname(filename).toLowerCase();
    return IMAGE_EXTENSIONS[ext] || null;
  }

  private async addImageFromFile(file: File, source: 'paste' | 'drop'): Promise<boolean> {
    if (file.size > MAX_IMAGE_SIZE) {
      this.notifyImageError(`Image exceeds ${this.formatSize(MAX_IMAGE_SIZE)} limit.`);
      return false;
    }

    const mediaType = this.getMediaType(file.name) || (file.type as ImageMediaType);
    if (!mediaType) {
      this.notifyImageError('Unsupported image type.');
      return false;
    }

    try {
      const { buffer, base64 } = await this.fileToBufferAndBase64(file);
      const cacheEntry = saveImageToCache(this.app, buffer, mediaType, file.name);
      if (!cacheEntry) {
        this.notifyImageError('Failed to save image to cache.');
        return false;
      }

      const attachment: ImageAttachment = {
        id: this.generateId(),
        name: file.name || `image-${Date.now()}.${mediaType.split('/')[1]}`,
        mediaType,
        data: base64,
        cachePath: cacheEntry.relPath,
        size: file.size,
        source,
      };

      this.attachedImages.set(attachment.id, attachment);
      this.updateImagePreview();
      this.callbacks.onImagesChanged();
      return true;
    } catch (error) {
      this.notifyImageError('Failed to attach image.', error);
      return false;
    }
  }

  private async loadImageFromPath(imagePath: string): Promise<ImageAttachment | null> {
    const mediaType = this.getMediaType(imagePath);
    if (!mediaType) {
      return null;
    }

    const normalizedInput = normalizePathForFilesystem(imagePath);
    let fullPath = normalizedInput;
    const vaultPath = getVaultPath(this.app);
    const mediaFolder = this.callbacks.getMediaFolder
      ? this.callbacks.getMediaFolder().trim()
      : undefined;

    if (!path.isAbsolute(normalizedInput)) {
      const candidates: string[] = [];
      if (vaultPath) {
        candidates.push(path.join(vaultPath, normalizedInput));
        if (mediaFolder) {
          candidates.push(path.join(vaultPath, mediaFolder, normalizedInput));
        }
      }
      const foundPath = candidates.find(p => fs.existsSync(p));
      if (foundPath) {
        fullPath = foundPath;
      }
    }

    if (!fs.existsSync(fullPath)) {
      const normalizedMediaFolder = mediaFolder
        ?.replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
      const vaultRelativePath = normalizedInput.replace(/\\/g, '/');
      const vaultPaths = [
        vaultRelativePath,
        normalizedMediaFolder ? `${normalizedMediaFolder}/${vaultRelativePath}` : null,
      ].filter(Boolean) as string[];

      for (const vaultRelativePath of vaultPaths) {
        const file = this.app.vault.getAbstractFileByPath(vaultRelativePath);
        if (file instanceof TFile) {
          const fileSize = (file as any).stat?.size ?? 0;
          if (fileSize > MAX_IMAGE_SIZE) {
            return null;
          }

          const arrayBuffer = await this.app.vault.readBinary(file);
          const base64 = this.arrayBufferToBase64(arrayBuffer);
          return {
            id: this.generateId(),
            name: file.name,
            mediaType,
            data: base64,
            filePath: file.path,
            size: arrayBuffer.byteLength,
            source: 'file',
          };
        }
      }
      return null;
    }

    const stats = fs.statSync(fullPath);
    if (stats.size > MAX_IMAGE_SIZE) {
      return null;
    }

    const buffer = fs.readFileSync(fullPath);
    const base64 = buffer.toString('base64');
    const storedPath = this.getStoredFilePath(fullPath, vaultPath);

    return {
      id: this.generateId(),
      name: path.basename(fullPath),
      mediaType,
      data: base64,
      filePath: storedPath,
      size: stats.size,
      source: 'file',
    };
  }

  private async fileToBufferAndBase64(file: File): Promise<{ buffer: Buffer; base64: string }> {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return {
      buffer,
      base64: buffer.toString('base64'),
    };
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // ============================================
  // Private: Image Preview
  // ============================================

  private updateImagePreview() {
    this.imagePreviewEl.empty();

    if (this.attachedImages.size === 0) {
      this.imagePreviewEl.style.display = 'none';
      return;
    }

    this.imagePreviewEl.style.display = 'flex';

    for (const [id, image] of this.attachedImages) {
      this.renderImagePreview(id, image);
    }
  }

  private renderImagePreview(id: string, image: ImageAttachment) {
    const previewEl = this.imagePreviewEl.createDiv({ cls: 'claudian-image-chip' });

    const thumbEl = previewEl.createDiv({ cls: 'claudian-image-thumb' });
    thumbEl.createEl('img', {
      attr: {
        src: `data:${image.mediaType};base64,${image.data}`,
        alt: image.name,
      },
    });

    const infoEl = previewEl.createDiv({ cls: 'claudian-image-info' });
    const nameEl = infoEl.createSpan({ cls: 'claudian-image-name' });
    nameEl.setText(this.truncateName(image.name, 20));
    nameEl.setAttribute('title', image.name);

    const sizeEl = infoEl.createSpan({ cls: 'claudian-image-size' });
    sizeEl.setText(this.formatSize(image.size));

    const removeEl = previewEl.createSpan({ cls: 'claudian-image-remove' });
    removeEl.setText('\u00D7');
    removeEl.setAttribute('aria-label', 'Remove image');

    removeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.attachedImages.delete(id);
      this.updateImagePreview();
      this.callbacks.onImagesChanged();
    });

    thumbEl.addEventListener('click', () => {
      this.showFullImage(image);
    });
  }

  private showFullImage(image: ImageAttachment) {
    const overlay = document.body.createDiv({ cls: 'claudian-image-modal-overlay' });
    const modal = overlay.createDiv({ cls: 'claudian-image-modal' });

    modal.createEl('img', {
      attr: {
        src: `data:${image.mediaType};base64,${image.data}`,
        alt: image.name,
      },
    });

    const closeBtn = modal.createDiv({ cls: 'claudian-image-modal-close' });
    closeBtn.setText('\u00D7');

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
      }
    };

    const close = () => {
      document.removeEventListener('keydown', handleEsc);
      overlay.remove();
    };

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', handleEsc);
  }

  private generateId(): string {
    return `img-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private truncateName(name: string, maxLen: number): string {
    if (name.length <= maxLen) return name;
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    const truncatedBase = base.slice(0, maxLen - ext.length - 3);
    return `${truncatedBase}...${ext}`;
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private cleanImagePathToken(token: string): string | null {
    let cleaned = token.trim();
    cleaned = cleaned.replace(/^["'`]+|["'`]+$/g, '');
    cleaned = cleaned.replace(/^!\[[^\]]*]\(/, '');
    cleaned = cleaned.replace(/^[\[(<]+/, '');
    cleaned = cleaned.replace(/[)\],.;>]+$/g, '');
    return cleaned || null;
  }

  private normalizeCandidatePath(candidate: string | null): string | null {
    if (!candidate) return null;
    const cleaned = this.cleanImagePathToken(candidate);
    if (!cleaned) return null;
    if (/^file:\/\//i.test(cleaned)) {
      return this.parseFileUrlToPath(cleaned);
    }
    if (/^https?:\/\//i.test(cleaned)) {
      return null;
    }
    // Reject paths with obvious path traversal attempts
    // Note: This is a basic check; actual file access is still validated by the OS/vault
    if (cleaned.includes('../') || cleaned.includes('..\\')) {
      return null;
    }
    return cleaned;
  }

  private extractMarkdownImagePath(text: string): string | null {
    const match = text.match(/!\[[^\]]*]\(([^)]+)\)/);
    if (!match) return null;

    let inside = match[1].trim();

    if (inside.startsWith('<') && inside.endsWith('>')) {
      inside = inside.slice(1, -1).trim();
    }

    const quoted = inside.match(/^"([^"]+)"|^'([^']+)'/);
    if (quoted) {
      inside = quoted[1] ?? quoted[2] ?? inside;
    }

    if (/\s/.test(inside)) {
      inside = inside.split(/\s+/)[0];
    }

    return inside || null;
  }

  private extractHtmlImagePath(text: string): string | null {
    const match = text.match(/<img[^>]+src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    if (!match) return null;
    return match[1] ?? match[2] ?? match[3] ?? null;
  }

  private parseFileUrlToPath(value: string): string | null {
    try {
      const url = new URL(value);
      if (url.protocol !== 'file:') return null;

      const host = url.hostname;
      const hostLower = host.toLowerCase();
      const isLocalHost = hostLower === '' || hostLower === 'localhost' || hostLower === '127.0.0.1' || hostLower === '::1';

      let pathname = decodeURIComponent(url.pathname || '');
      if (!pathname) return null;

      // Windows drive paths like file:///C:/Users/... or file://localhost/C:/Users/...
      if (isLocalHost && /^\/[a-zA-Z]:\//.test(pathname)) {
        pathname = pathname.slice(1);
        return pathname.replace(/\//g, '\\');
      }

      // file://C:/Users/... (host is drive letter)
      if (/^[a-zA-Z]:$/.test(host)) {
        const combined = `${host}${pathname}`;
        return combined.replace(/\//g, '\\');
      }

      // UNC paths: file://server/share/path -> \\server\share\path
      if (!isLocalHost && host) {
        return `\\\\${host}${pathname.replace(/\//g, '\\')}`;
      }

      return pathname;
    } catch (error) {
      console.warn('Failed to parse file URL:', value, error);
      return null;
    }
  }

  private notifyImageError(message: string, error?: unknown) {
    if (error) {
      console.error(message, error);
    } else {
      console.warn(message);
    }
    // Provide more actionable error messages
    let userMessage = message;
    if (error instanceof Error) {
      if (error.message.includes('ENOENT') || error.message.includes('no such file')) {
        userMessage = `${message} (File not found)`;
      } else if (error.message.includes('EACCES') || error.message.includes('permission denied')) {
        userMessage = `${message} (Permission denied)`;
      }
    }
    new Notice(userMessage);
  }

  private getStoredFilePath(fullPath: string, vaultPath: string | null): string {
    const normalizedFull = normalizePathForFilesystem(fullPath);
    if (vaultPath && isPathWithinVault(normalizedFull, vaultPath)) {
      const absolute = path.isAbsolute(normalizedFull)
        ? normalizedFull
        : path.resolve(vaultPath, normalizedFull);
      const relative = path.relative(vaultPath, absolute);
      return relative.replace(/\\/g, '/');
    }
    return normalizedFull;
  }
}
