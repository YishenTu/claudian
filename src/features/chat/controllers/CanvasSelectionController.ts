import type { App, ItemView } from 'obsidian';

import type { CanvasSelectionContext } from '../../../utils/canvas';

const CANVAS_POLL_INTERVAL = 250;

interface StoredCanvasSelection {
  canvasPath: string;
  nodeIds: string[];
}

export class CanvasSelectionController {
  private app: App;
  private indicatorEl: HTMLElement;
  private inputEl: HTMLElement;
  private contextRowEl: HTMLElement;
  private onVisibilityChange: (() => void) | null;
  private storedSelection: StoredCanvasSelection | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    app: App,
    indicatorEl: HTMLElement,
    inputEl: HTMLElement,
    contextRowEl: HTMLElement,
    onVisibilityChange?: () => void
  ) {
    this.app = app;
    this.indicatorEl = indicatorEl;
    this.inputEl = inputEl;
    this.contextRowEl = contextRowEl;
    this.onVisibilityChange = onVisibilityChange ?? null;
  }

  start(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => this.poll(), CANVAS_POLL_INTERVAL);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.clear();
  }

  dispose(): void {
    this.stop();
  }

  // ============================================
  // Canvas Selection Polling
  // ============================================

  private poll(): void {
    const canvasView = this.getCanvasView();
    if (!canvasView) return;

    const canvas = (canvasView as any).canvas;
    if (!canvas?.selection) return;

    const selection: Set<{ id: string }> = canvas.selection;
    const canvasPath = (canvasView as any).file?.path;
    if (!canvasPath) return;

    const nodeIds = [...selection].map(node => node.id).filter(Boolean);

    if (nodeIds.length > 0) {
      const sameSelection = this.storedSelection
        && this.storedSelection.canvasPath === canvasPath
        && this.storedSelection.nodeIds.length === nodeIds.length
        && this.storedSelection.nodeIds.every(id => nodeIds.includes(id));

      if (!sameSelection) {
        this.storedSelection = { canvasPath, nodeIds };
        this.updateIndicator();
      }
    } else if (document.activeElement !== this.inputEl) {
      if (this.storedSelection) {
        this.storedSelection = null;
        this.updateIndicator();
      }
    }
  }

  private getCanvasView(): ItemView | null {
    const leaves = this.app.workspace.getLeavesOfType('canvas');
    if (leaves.length === 0) return null;
    const leaf = leaves.find(l => (l.view as any).file);
    return leaf ? (leaf.view as ItemView) : null;
  }

  // ============================================
  // Indicator
  // ============================================

  private updateIndicator(): void {
    if (!this.indicatorEl) return;

    if (this.storedSelection) {
      const { nodeIds } = this.storedSelection;
      this.indicatorEl.textContent = nodeIds.length === 1
        ? `node "${nodeIds[0]}" selected`
        : `${nodeIds.length} nodes selected`;
      this.indicatorEl.style.display = 'block';
    } else {
      this.indicatorEl.style.display = 'none';
    }
    this.updateContextRowVisibility();
  }

  updateContextRowVisibility(): void {
    if (!this.contextRowEl) return;
    const hasSelection = this.storedSelection !== null;
    const fileIndicator = this.contextRowEl.querySelector('.claudian-file-indicator') as HTMLElement | null;
    const imagePreview = this.contextRowEl.querySelector('.claudian-image-preview') as HTMLElement | null;
    const hasFileChips = fileIndicator?.style.display === 'flex';
    const hasImageChips = imagePreview?.style.display === 'flex';
    this.contextRowEl.classList.toggle('has-content', hasSelection || hasFileChips || hasImageChips);
    this.onVisibilityChange?.();
  }

  // ============================================
  // Context Access
  // ============================================

  getContext(): CanvasSelectionContext | null {
    if (!this.storedSelection) return null;
    return {
      canvasPath: this.storedSelection.canvasPath,
      nodeIds: [...this.storedSelection.nodeIds],
    };
  }

  hasSelection(): boolean {
    return this.storedSelection !== null;
  }

  // ============================================
  // Clear
  // ============================================

  clear(): void {
    this.storedSelection = null;
    this.updateIndicator();
  }
}
