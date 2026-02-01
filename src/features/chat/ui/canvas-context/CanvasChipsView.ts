/**
 * Canvas Chips View
 *
 * Renders canvas context as chips in the input area,
 * similar to FileChipsView for file context.
 */

import { setIcon } from 'obsidian';
import type { CanvasContext } from './CanvasContextManager';
import { getNodeSummary } from './fileUtil';

export interface CanvasChipsViewCallbacks {
  /** Called when user clicks to open the canvas */
  onOpenCanvas?: (filePath: string) => void;
  /** Called when user removes the canvas context */
  onRemoveContext?: () => void;
  /** Called when user clicks on a specific node */
  onFocusNode?: (nodeId: string) => void;
}

/**
 * Renders canvas context chips in the UI.
 */
export class CanvasChipsView {
  private containerEl: HTMLElement;
  private callbacks: CanvasChipsViewCallbacks;
  private canvasIndicatorEl: HTMLElement;

  constructor(containerEl: HTMLElement, callbacks: CanvasChipsViewCallbacks = {}) {
    this.containerEl = containerEl;
    this.callbacks = callbacks;

    // Create the canvas indicator element
    this.canvasIndicatorEl = this.containerEl.createDiv({
      cls: 'claudian-canvas-indicator',
    });

    // Insert at the beginning of the container
    const firstChild = this.containerEl.firstChild;
    if (firstChild && firstChild !== this.canvasIndicatorEl) {
      this.containerEl.insertBefore(this.canvasIndicatorEl, firstChild);
    }
  }

  /**
   * Render the canvas context chips.
   */
  render(context: CanvasContext | null): void {
    this.canvasIndicatorEl.empty();

    if (!context) {
      this.canvasIndicatorEl.style.display = 'none';
      return;
    }

    this.canvasIndicatorEl.style.display = 'flex';

    // Render canvas file chip
    this.renderCanvasChip(context);

    // Render selected nodes if any
    if (context.selectedNodes.length > 0) {
      this.renderNodeChips(context);
    }
  }

  /**
   * Render the canvas file chip.
   */
  private renderCanvasChip(context: CanvasContext): void {
    const chipEl = this.canvasIndicatorEl.createDiv({
      cls: 'claudian-canvas-chip claudian-canvas-file-chip',
    });

    // Canvas icon
    const iconEl = chipEl.createSpan({ cls: 'claudian-canvas-chip-icon' });
    setIcon(iconEl, 'layout-dashboard');

    // Canvas name
    const nameEl = chipEl.createSpan({ cls: 'claudian-canvas-chip-name' });
    nameEl.setText(context.canvasFile.basename);
    nameEl.setAttribute('title', context.canvasFile.path);

    // Click to open canvas
    chipEl.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.claudian-canvas-chip-remove')) {
        this.callbacks.onOpenCanvas?.(context.canvasFile.path);
      }
    });
  }

  /**
   * Render selected node chips.
   */
  private renderNodeChips(context: CanvasContext): void {
    // Add separator
    const separatorEl = this.canvasIndicatorEl.createSpan({
      cls: 'claudian-canvas-separator',
    });
    separatorEl.setText('›');

    if (context.selectedNodes.length === 1) {
      // Single node - show summary
      const node = context.selectedNodes[0];
      this.renderSingleNodeChip(node);
    } else {
      // Multiple nodes - show count
      this.renderMultiNodeChip(context.selectedNodes.length);
    }
  }

  /**
   * Render a single node chip with summary.
   */
  private renderSingleNodeChip(node: any): void {
    const chipEl = this.canvasIndicatorEl.createDiv({
      cls: 'claudian-canvas-chip claudian-canvas-node-chip',
    });

    // Node icon based on type
    const iconEl = chipEl.createSpan({ cls: 'claudian-canvas-chip-icon' });
    const nodeData = node.getData();
    const iconName = this.getNodeIcon(nodeData.type);
    setIcon(iconEl, iconName);

    // Node summary
    const summary = getNodeSummary(node, 40);
    const nameEl = chipEl.createSpan({ cls: 'claudian-canvas-chip-name' });
    nameEl.setText(summary);

    // Ancestor count indicator
    const ancestorCount = this.getAncestorCountHint(node);
    if (ancestorCount > 0) {
      const countEl = chipEl.createSpan({ cls: 'claudian-canvas-ancestor-count' });
      countEl.setText(`+${ancestorCount}`);
      countEl.setAttribute('title', `Including ${ancestorCount} ancestor node(s) in context`);
    }

    // Click to focus node
    chipEl.addEventListener('click', () => {
      this.callbacks.onFocusNode?.(node.id);
    });
  }

  /**
   * Render a chip showing multiple selected nodes.
   */
  private renderMultiNodeChip(count: number): void {
    const chipEl = this.canvasIndicatorEl.createDiv({
      cls: 'claudian-canvas-chip claudian-canvas-multi-chip',
    });

    // Multi-select icon
    const iconEl = chipEl.createSpan({ cls: 'claudian-canvas-chip-icon' });
    setIcon(iconEl, 'layers');

    // Count text
    const nameEl = chipEl.createSpan({ cls: 'claudian-canvas-chip-name' });
    nameEl.setText(`${count} nodes selected`);
  }

  /**
   * Get the appropriate icon for a node type.
   */
  private getNodeIcon(type: string): string {
    switch (type) {
      case 'text':
        return 'text';
      case 'file':
        return 'file';
      case 'link':
        return 'link';
      case 'group':
        return 'box-select';
      default:
        return 'square';
    }
  }

  /**
   * Get a hint of how many ancestors are included.
   * This is a rough estimate based on edges.
   */
  private getAncestorCountHint(node: any): number {
    try {
      const canvas = node.canvas;
      if (!canvas) return 0;

      const visited = new Set<string>();
      const queue = [node];
      let count = 0;

      while (queue.length > 0 && count < 20) {
        const current = queue.shift()!;
        if (visited.has(current.id)) continue;
        visited.add(current.id);

        const edges = canvas.getEdgesForNode(current);
        const parents = edges
          .filter((e: any) => e.to.node.id === current.id)
          .map((e: any) => e.from.node);

        for (const parent of parents) {
          if (!visited.has(parent.id)) {
            queue.push(parent);
            count++;
          }
        }
      }

      return count;
    } catch {
      return 0;
    }
  }

  /**
   * Hide the canvas indicator.
   */
  hide(): void {
    this.canvasIndicatorEl.style.display = 'none';
  }

  /**
   * Show the canvas indicator.
   */
  show(): void {
    this.canvasIndicatorEl.style.display = 'flex';
  }

  /**
   * Cleanup resources.
   */
  destroy(): void {
    this.canvasIndicatorEl.remove();
  }
}
