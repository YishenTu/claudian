import type { App, ItemView } from 'obsidian';

import type { CanvasSelectionContext } from '../../../utils/canvas';
import { updateContextRowHasContent } from './contextRowVisibility';

const CANVAS_POLL_INTERVAL = 250;

type CanvasSelectionNode = { id?: unknown };

type CanvasViewLike = ItemView & {
  canvas?: {
    selection?: Set<CanvasSelectionNode>;
  };
  file?: {
    path?: unknown;
  };
};

export class CanvasSelectionController {
  private app: App;
  private indicatorEl: HTMLElement;
  private inputEl: HTMLElement;
  private contextRowEl: HTMLElement;
  private onVisibilityChange: (() => void) | null;
  private storedSelection: CanvasSelectionContext | null = null;
  private pollInterval: number | null = null;

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
    this.pollInterval = window.setInterval(() => this.poll(), CANVAS_POLL_INTERVAL);
  }

  stop(): void {
    if (this.pollInterval) {
      window.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.clear();
  }

  private poll(): void {
    const canvasView = this.getCanvasView();
    if (!canvasView) return;

    const canvas = canvasView.canvas;
    if (!canvas?.selection) return;

    const selection = canvas.selection;
    const canvasPath = canvasView.file?.path;
    if (typeof canvasPath !== 'string' || !canvasPath) return;

    const nodeIds = [...selection]
      .map(node => node.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (nodeIds.length > 0) {
      const sameSelection = this.storedSelection
        && this.storedSelection.canvasPath === canvasPath
        && this.storedSelection.nodeIds.length === nodeIds.length
        && this.storedSelection.nodeIds.every(id => nodeIds.includes(id));

      if (!sameSelection) {
        this.storedSelection = { canvasPath, nodeIds };
        this.updateIndicator();
      }
    } else if (this.getActiveElement() !== this.inputEl) {
      if (this.storedSelection) {
        this.storedSelection = null;
        this.updateIndicator();
      }
    }
  }

  private getActiveElement(): Element | null {
    return this.inputEl.ownerDocument?.activeElement ?? null;
  }

  private getCanvasView(): CanvasViewLike | null {
    const activeLeaf = this.app.workspace.getMostRecentLeaf?.();
    const activeView = activeLeaf?.view as CanvasViewLike | undefined;
    if (activeView?.getViewType?.() === 'canvas' && activeView.file) {
      return activeView;
    }

    const leaves = this.app.workspace.getLeavesOfType('canvas');
    if (leaves.length === 0) return null;
    const leaf = leaves.find(l => (l.view as CanvasViewLike).file);
    return leaf ? (leaf.view as CanvasViewLike) : null;
  }

  private updateIndicator(): void {
    if (!this.indicatorEl) return;

    if (this.storedSelection) {
      const { nodeIds } = this.storedSelection;
      this.indicatorEl.textContent = nodeIds.length === 1
        ? `node "${nodeIds[0]}" selected`
        : `${nodeIds.length} nodes selected`;
      this.indicatorEl.removeClass('claudian-hidden');
    } else {
      this.indicatorEl.addClass('claudian-hidden');
    }
    this.updateContextRowVisibility();
  }

  updateContextRowVisibility(): void {
    if (!this.contextRowEl) return;
    updateContextRowHasContent(this.contextRowEl);
    this.onVisibilityChange?.();
  }

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

  clear(): void {
    this.storedSelection = null;
    this.updateIndicator();
  }
}
