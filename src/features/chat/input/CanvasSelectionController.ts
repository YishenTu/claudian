import type { App, ItemView } from 'obsidian';

import type { CanvasSelectionContext } from '@/core/prompt/canvasContext';
import type { ComposerContextTray } from '@/features/chat/composer/ComposerContextTray';
import { t } from '@/i18n/i18n';

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
  private sourceView: CanvasViewLike | null = null;

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
    if (!canvasView) {
      const activeView = this.app.workspace.getMostRecentLeaf?.()?.view;
      const ownInputHandoff = this.inputEl.contains(this.#getActiveElement())
        && activeView?.containerEl?.contains(this.inputEl)
        && this.sourceView?.file?.path === this.storedSelection?.canvasPath
        && this.app.workspace.getLeavesOfType('canvas').some(leaf => leaf.view === this.sourceView);
      if (!ownInputHandoff) this.#clearSelection();
      return;
    }

    const canvas = canvasView.canvas;
    if (!canvas?.selection) return;

    const selection = canvas.selection;
    const canvasPath = canvasView.file?.path;
    if (typeof canvasPath !== 'string' || !canvasPath) return;

    const nodeIds = [...selection]
      .map(node => node.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (nodeIds.length > 0) {
      const sameSelection = this.sourceView === canvasView && this.storedSelection
        && this.storedSelection.canvasPath === canvasPath
        && this.storedSelection.nodeIds.length === nodeIds.length
        && this.storedSelection.nodeIds.every(id => nodeIds.includes(id));

      if (!sameSelection) {
        this.sourceView = canvasView;
        this.storedSelection = { canvasPath, nodeIds };
        this.updateIndicator();
        this.onUserSelectionChanged?.();
      }
    } else if (!this.inputEl.contains(this.#getActiveElement())
      || this.sourceView !== canvasView || this.storedSelection?.canvasPath !== canvasPath) {
      this.#clearSelection();
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

    return null;
  }

  private updateIndicator(): void {
    if (this.storedSelection) {
      const { nodeIds } = this.storedSelection;
      const label = t(nodeIds.length === 1 ? 'chat.selectedContext.node' : 'chat.selectedContext.nodes', { count: nodeIds.length });
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
    return this.storedSelection;
  }

  hasSelection(): boolean {
    return this.storedSelection !== null;
  }

  #clearSelection(): void {
    if (!this.storedSelection) return;
    this.clear();
    this.onUserSelectionChanged?.();
  }

  clear(): void {
    this.sourceView = null;
    this.storedSelection = null;
    this.updateIndicator();
  }
}
