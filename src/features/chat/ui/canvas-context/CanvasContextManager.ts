/**
 * Canvas Context Manager
 *
 * Manages awareness of the current Canvas view and selected nodes.
 * Provides context from selected nodes (including ancestor chain) for AI conversations.
 */

import type { App, TFile, EventRef, WorkspaceLeaf, ItemView } from 'obsidian';
import type { Canvas, CanvasNode, CanvasView } from './canvas-internal';
import { collectAncestors } from './canvasUtil';
import { readNodeContent, getNodeSummary } from './fileUtil';

/**
 * Represents the context from a single selected node and its ancestors.
 */
export interface NodeContext {
  node: CanvasNode;
  summary: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    nodeId: string;
  }>;
}

/**
 * Represents the full canvas context.
 */
export interface CanvasContext {
  /** The canvas file */
  canvasFile: TFile;
  /** Currently selected nodes */
  selectedNodes: CanvasNode[];
  /** Context for each selected node (including ancestors) */
  nodeContexts: NodeContext[];
  /** Formatted context string for injection into prompts */
  formattedContext: string;
}

export interface CanvasContextCallbacks {
  onContextChange?: () => void;
}

/**
 * Manages Canvas context awareness for Claudian.
 */
export class CanvasContextManager {
  private app: App;
  private callbacks: CanvasContextCallbacks;
  private currentContext: CanvasContext | null = null;
  private leafChangeRef: EventRef | null = null;
  private layoutChangeRef: EventRef | null = null;
  private selectionCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastSelectionIds: string = '';
  private maxAncestorDepth: number = 10;

  constructor(app: App, callbacks: CanvasContextCallbacks = {}) {
    this.app = app;
    this.callbacks = callbacks;
  }

  /**
   * Start watching for canvas changes.
   */
  startWatching(): void {
    // Watch for active leaf changes
    this.leafChangeRef = this.app.workspace.on('active-leaf-change', () => {
      this.checkAndNotify();
    });

    // Watch for layout changes (tab switches, etc.)
    this.layoutChangeRef = this.app.workspace.on('layout-change', () => {
      this.checkAndNotify();
    });

    // Poll for selection changes (Canvas doesn't emit selection events)
    this.selectionCheckInterval = setInterval(() => {
      this.checkSelectionChange();
    }, 500);

    // Initial check
    this.checkAndNotify();
  }

  /**
   * Stop watching for changes.
   */
  stopWatching(): void {
    if (this.leafChangeRef) {
      this.app.workspace.offref(this.leafChangeRef);
      this.leafChangeRef = null;
    }
    if (this.layoutChangeRef) {
      this.app.workspace.offref(this.layoutChangeRef);
      this.layoutChangeRef = null;
    }
    if (this.selectionCheckInterval) {
      clearInterval(this.selectionCheckInterval);
      this.selectionCheckInterval = null;
    }
  }

  /**
   * Check if the current view is a Canvas.
   */
  isCanvasActive(): boolean {
    return this.getActiveCanvas() !== null;
  }

  /**
   * Get the active Canvas instance if available.
   */
  getActiveCanvas(): Canvas | null {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (!activeLeaf) return null;

    const view = activeLeaf.view as ItemView & { canvas?: Canvas };
    if (view.getViewType() === 'canvas' && view.canvas) {
      return view.canvas;
    }
    return null;
  }

  /**
   * Get the active Canvas file.
   */
  getActiveCanvasFile(): TFile | null {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (!activeLeaf) return null;

    const view = activeLeaf.view as ItemView & { file?: TFile };
    if (view.getViewType() === 'canvas' && view.file) {
      return view.file;
    }
    return null;
  }

  /**
   * Get currently selected nodes in the active Canvas.
   */
  getSelectedNodes(): CanvasNode[] {
    const canvas = this.getActiveCanvas();
    if (!canvas?.selection) return [];
    return Array.from(canvas.selection.values());
  }

  /**
   * Get the current canvas context.
   */
  getCurrentContext(): CanvasContext | null {
    return this.currentContext;
  }

  /**
   * Refresh and get the current canvas context.
   */
  async refreshContext(): Promise<CanvasContext | null> {
    const canvasFile = this.getActiveCanvasFile();
    if (!canvasFile) {
      this.currentContext = null;
      return null;
    }

    const selectedNodes = this.getSelectedNodes();
    if (selectedNodes.length === 0) {
      // No selection - still provide canvas file info
      this.currentContext = {
        canvasFile,
        selectedNodes: [],
        nodeContexts: [],
        formattedContext: `[Canvas: ${canvasFile.basename}]\nNo nodes selected.`,
      };
      return this.currentContext;
    }

    // Build context for each selected node
    const nodeContexts: NodeContext[] = [];

    for (const node of selectedNodes) {
      const context = await this.buildNodeContext(node);
      if (context) {
        nodeContexts.push(context);
      }
    }

    // Format the complete context
    const formattedContext = this.formatContext(canvasFile, nodeContexts);

    this.currentContext = {
      canvasFile,
      selectedNodes,
      nodeContexts,
      formattedContext,
    };

    return this.currentContext;
  }

  /**
   * Build context for a single node including its ancestors.
   */
  private async buildNodeContext(node: CanvasNode): Promise<NodeContext | null> {
    try {
      const ancestors = await collectAncestors(node, this.maxAncestorDepth);
      const messages: NodeContext['messages'] = [];

      for (const ancestorNode of ancestors) {
        const content = await readNodeContent(ancestorNode);
        if (!content?.trim()) continue;

        // Skip system prompt nodes
        if (content.trim().toUpperCase().startsWith('SYSTEM PROMPT')) {
          messages.push({
            role: 'system',
            content: content.trim(),
            nodeId: ancestorNode.id,
          });
          continue;
        }

        const nodeData = ancestorNode.getData();
        const role = nodeData.chat_role === 'assistant' ? 'assistant' : 'user';

        messages.push({
          role,
          content: content.trim(),
          nodeId: ancestorNode.id,
        });
      }

      return {
        node,
        summary: getNodeSummary(node),
        messages,
      };
    } catch (error) {
      console.error('Failed to build node context:', error);
      return null;
    }
  }

  /**
   * Format the canvas context for display and injection.
   */
  private formatContext(canvasFile: TFile, nodeContexts: NodeContext[]): string {
    const parts: string[] = [];

    parts.push(`[Canvas: ${canvasFile.basename}]`);
    parts.push(`[Selected: ${nodeContexts.length} node(s)]`);
    parts.push('');

    for (let i = 0; i < nodeContexts.length; i++) {
      const ctx = nodeContexts[i];

      if (nodeContexts.length > 1) {
        parts.push(`=== Node ${i + 1}: ${ctx.summary} ===`);
        parts.push('');
      }

      for (const msg of ctx.messages) {
        const roleLabel = msg.role.toUpperCase();
        parts.push(`[${roleLabel}]`);
        parts.push(msg.content);
        parts.push('');
      }
    }

    return parts.join('\n').trim();
  }

  /**
   * Get a brief description of the current context for UI display.
   */
  getContextDescription(): string | null {
    if (!this.currentContext) return null;

    const { canvasFile, selectedNodes } = this.currentContext;

    if (selectedNodes.length === 0) {
      return `${canvasFile.basename}`;
    }

    if (selectedNodes.length === 1) {
      const summary = getNodeSummary(selectedNodes[0], 30);
      return `${canvasFile.basename} > ${summary}`;
    }

    return `${canvasFile.basename} > ${selectedNodes.length} nodes`;
  }

  /**
   * Check for selection changes and notify if changed.
   */
  private checkSelectionChange(): void {
    const selectedNodes = this.getSelectedNodes();
    const currentIds = selectedNodes
      .map((n) => n.id)
      .sort()
      .join(',');

    if (currentIds !== this.lastSelectionIds) {
      this.lastSelectionIds = currentIds;
      this.checkAndNotify();
    }
  }

  /**
   * Check context and notify if changed.
   */
  private async checkAndNotify(): Promise<void> {
    const previousContext = this.currentContext;
    await this.refreshContext();

    const hasChanged = this.hasContextChanged(previousContext, this.currentContext);
    if (hasChanged) {
      this.callbacks.onContextChange?.();
    }
  }

  /**
   * Check if context has meaningfully changed.
   */
  private hasContextChanged(
    prev: CanvasContext | null,
    curr: CanvasContext | null
  ): boolean {
    if (!prev && !curr) return false;
    if (!prev || !curr) return true;

    // Check canvas file
    if (prev.canvasFile.path !== curr.canvasFile.path) return true;

    // Check selected node IDs
    const prevIds = prev.selectedNodes
      .map((n) => n.id)
      .sort()
      .join(',');
    const currIds = curr.selectedNodes
      .map((n) => n.id)
      .sort()
      .join(',');

    return prevIds !== currIds;
  }

  /**
   * Set maximum ancestor depth for context collection.
   */
  setMaxAncestorDepth(depth: number): void {
    this.maxAncestorDepth = depth;
  }

  /**
   * Cleanup resources.
   */
  destroy(): void {
    this.stopWatching();
    this.currentContext = null;
  }
}
