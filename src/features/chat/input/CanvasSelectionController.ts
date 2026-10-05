import type { App, ItemView } from 'obsidian';

import type { CanvasSelectionContext } from '@/core/prompt/canvasContext';
import type { ComposerContextTray } from '@/features/chat/composer/ComposerContextTray';

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
  private contextTray: ComposerContextTray;
  private inputEl: HTMLElement;
  private onUserSelectionChanged: (() => void) | null;
  private storedSelection: CanvasSelectionContext | null = null;

  constructor(
    app: App,
    contextTray: ComposerContextTray,
    inputEl: HTMLElement,
    onUserSelectionChanged?: () => void,
  ) {
    this.app = app;
    this.contextTray = contextTray;
    this.inputEl = inputEl;
    this.onUserSelectionChanged = onUserSelectionChanged ?? null;
  }

  /** One polling tick; ComposerSelections owns the cadence. */
  poll(): void {
    const canvasView = this.#getCanvasView();
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
        this.onUserSelectionChanged?.();
      }
    } else if (!this.inputEl.contains(this.#getActiveElement())) {
      if (this.storedSelection) {
        this.storedSelection = null;
        this.updateIndicator();
        this.onUserSelectionChanged?.();
      }
    }
  }

  #getActiveElement(): Element | null {
    return this.inputEl.ownerDocument?.activeElement ?? null;
  }

  #getCanvasView(): CanvasViewLike | null {
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
    if (this.storedSelection) {
      const { nodeIds } = this.storedSelection;
      const nodeLabel = nodeIds.length === 1 ? '1 node' : `${nodeIds.length} nodes`;
      const label = `${nodeLabel} selected`;
      this.contextTray.setItems('canvas-selection', [{
        id: 'canvas-selection',
        kind: 'selection',
        label,
        icon: 'network',
        ariaLabel: label,
        onRemove: () => {
          this.clear();
          this.onUserSelectionChanged?.();
        },
      }]);
    } else {
      this.contextTray.clearItems('canvas-selection');
    }
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
