/**
 * Canvas Context Manager
 *
 * Manages awareness of the current Canvas view and selected nodes.
 * Provides context from selected nodes (including ancestor chain) for AI conversations.
 */

import type { App, EventRef, ItemView } from 'obsidian';
import { TFile } from 'obsidian';

import type { Canvas, CanvasNode } from './canvas-internal';
import { collectAncestors } from './canvasUtil';
import { getNodeSummary, readNodeContent } from './fileUtil';

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
    /** True if this is the currently selected node (not an ancestor). */
    isCurrentNode: boolean;
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
 * Represents a pinned node that the user has explicitly added to context.
 */
export interface PinnedNode {
  nodeId: string;
  canvasPath: string;
  summary: string;
  nodeType: string;
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

  /**
   * Sticky selection: preserves the last valid canvas context even when
   * the user switches focus to the Claudian sidebar (input box).
   * This allows the context to persist until the user explicitly selects
   * different nodes or switches to a different canvas.
   */
  private stickyContext: CanvasContext | null = null;
  private stickyCanvasPath: string | null = null;

  /**
   * Pinned nodes: nodes that user has explicitly added to the context.
   * These are managed manually and persist until the user removes them.
   */
  private pinnedNodes: Map<string, PinnedNode> = new Map();
  private pinnedCanvasPath: string | null = null;

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
    // Using 200ms for more responsive selection detection
    this.selectionCheckInterval = setInterval(() => {
      this.checkSelectionChange();
    }, 200);

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
   * First checks the activeLeaf, then falls back to finding any canvas with selection.
   */
  getActiveCanvas(): Canvas | null {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf) {
      const view = activeLeaf.view as ItemView & { canvas?: Canvas };
      if (view.getViewType() === 'canvas' && view.canvas) {
        return view.canvas;
      }
    }

    // Fallback: if activeLeaf is not a canvas (e.g., user clicked sidebar),
    // try to find any open canvas that has a selection
    return this.findCanvasWithSelection();
  }

  /**
   * Find any open canvas that has selected nodes.
   * This is used as a fallback when activeLeaf is not a canvas.
   */
  private findCanvasWithSelection(): Canvas | null {
    const leaves = this.app.workspace.getLeavesOfType('canvas');
    for (const leaf of leaves) {
      const view = leaf.view as ItemView & { canvas?: Canvas };
      if (view.canvas?.selection && view.canvas.selection.size > 0) {
        return view.canvas;
      }
    }
    return null;
  }

  /**
   * Get the active Canvas file.
   * First checks the activeLeaf, then falls back to finding any canvas with selection.
   */
  getActiveCanvasFile(): TFile | null {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf) {
      const view = activeLeaf.view as ItemView & { file?: TFile };
      if (view.getViewType() === 'canvas' && view.file) {
        return view.file;
      }
    }

    // Fallback: if activeLeaf is not a canvas, try to find any open canvas with selection
    const leaves = this.app.workspace.getLeavesOfType('canvas');
    for (const leaf of leaves) {
      const view = leaf.view as ItemView & { canvas?: Canvas; file?: TFile };
      if (view.canvas?.selection && view.canvas.selection.size > 0 && view.file) {
        return view.file;
      }
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
   * Returns sticky context if available and no active canvas selection.
   */
  getCurrentContext(): CanvasContext | null {
    // If we have a current context with selected nodes, return it
    if (this.currentContext && this.currentContext.selectedNodes.length > 0) {
      return this.currentContext;
    }
    // Otherwise, return sticky context (preserved from last valid selection)
    return this.stickyContext;
  }

  /**
   * Refresh and get the current canvas context.
   * Implements sticky selection with pinned nodes management.
   */
  async refreshContext(): Promise<CanvasContext | null> {
    const canvasFile = this.getActiveCanvasFile();

    // Case 1: No active canvas view - return context from pinned nodes
    if (!canvasFile) {
      this.currentContext = null;
      // If we have pinned nodes, return sticky context built from them
      if (this.hasPinnedNodes()) {
        return this.stickyContext;
      }
      return null;
    }

    // Case 2: Different canvas than pinned - clear pinned nodes
    if (this.pinnedCanvasPath && this.pinnedCanvasPath !== canvasFile.path) {
      this.pinnedNodes.clear();
      this.pinnedCanvasPath = null;
      this.stickyContext = null;
      this.stickyCanvasPath = null;
    }

    const selectedNodes = this.getSelectedNodes();

    // Case 3: Canvas is active with new selection - replace pinned nodes with current selection
    if (selectedNodes.length > 0) {
      this.pinnedCanvasPath = canvasFile.path;
      
      // Clear existing pinned nodes and replace with current selection
      // This ensures the context always reflects the latest selection
      this.pinnedNodes.clear();
      
      for (const node of selectedNodes) {
        const nodeData = node.getData();
        this.pinnedNodes.set(node.id, {
          nodeId: node.id,
          canvasPath: canvasFile.path,
          summary: getNodeSummary(node, 50),
          nodeType: nodeData.type || 'text',
        });
      }
    }

    // Case 4: Build context from all pinned nodes
    if (this.pinnedNodes.size === 0) {
      this.currentContext = {
        canvasFile,
        selectedNodes: [],
        nodeContexts: [],
        formattedContext: `[Canvas: ${canvasFile.basename}]\nNo nodes selected.`,
      };
      return this.currentContext;
    }

    // Get the canvas to resolve pinned nodes
    const canvas = this.getActiveCanvas() || this.findCanvasByPath(canvasFile.path);
    if (!canvas) {
      return this.stickyContext;
    }

    // Build context from pinned nodes
    const nodeContexts: NodeContext[] = [];
    const resolvedNodes: CanvasNode[] = [];

    for (const pinnedNode of this.pinnedNodes.values()) {
      const node = this.findNodeById(canvas, pinnedNode.nodeId);
      if (node) {
        resolvedNodes.push(node);
        const context = await this.buildNodeContext(node);
        if (context) {
          nodeContexts.push(context);
        }
      } else {
        // Node no longer exists - remove from pinned
        this.pinnedNodes.delete(pinnedNode.nodeId);
      }
    }

    if (resolvedNodes.length === 0) {
      this.currentContext = {
        canvasFile,
        selectedNodes: [],
        nodeContexts: [],
        formattedContext: `[Canvas: ${canvasFile.basename}]\nNo nodes selected.`,
      };
      return this.currentContext;
    }

    // Format the complete context
    const formattedContext = this.formatContext(canvasFile, nodeContexts);

    this.currentContext = {
      canvasFile,
      selectedNodes: resolvedNodes,
      nodeContexts,
      formattedContext,
    };

    // Update sticky context
    this.stickyContext = this.currentContext;
    this.stickyCanvasPath = canvasFile.path;

    return this.currentContext;
  }

  /**
   * Clear sticky context and pinned nodes (call when starting a new conversation).
   */
  clearStickyContext(): void {
    this.stickyContext = null;
    this.stickyCanvasPath = null;
    this.pinnedNodes.clear();
    this.pinnedCanvasPath = null;
    this.currentContext = null;
    this.lastSelectionIds = '';
  }

  // ========================================
  // Pinned Nodes Management
  // ========================================

  /**
   * Pin the currently selected nodes to the context.
   * Pinned nodes persist until explicitly removed.
   * Returns a promise that resolves when the context has been updated.
   */
  async pinCurrentSelection(): Promise<void> {
    const canvas = this.getActiveCanvas();
    const canvasFile = this.getActiveCanvasFile();
    if (!canvas || !canvasFile) return;

    const selectedNodes = this.getSelectedNodes();
    if (selectedNodes.length === 0) return;

    // If switching to a different canvas, clear old pins
    if (this.pinnedCanvasPath && this.pinnedCanvasPath !== canvasFile.path) {
      this.pinnedNodes.clear();
    }
    this.pinnedCanvasPath = canvasFile.path;

    for (const node of selectedNodes) {
      const nodeData = node.getData();
      this.pinnedNodes.set(node.id, {
        nodeId: node.id,
        canvasPath: canvasFile.path,
        summary: getNodeSummary(node, 50),
        nodeType: nodeData.type || 'text',
      });
    }

    await this.refreshContextFromPinnedNodes();
  }

  /**
   * Remove a pinned node by ID.
   * Returns a promise that resolves when the context has been updated.
   */
  async unpinNode(nodeId: string): Promise<void> {
    this.pinnedNodes.delete(nodeId);
    await this.refreshContextFromPinnedNodes();
  }

  /**
   * Clear all pinned nodes.
   */
  clearPinnedNodes(): void {
    this.pinnedNodes.clear();
    this.pinnedCanvasPath = null;
    this.stickyContext = null;
    this.currentContext = null;
    this.callbacks.onContextChange?.();
  }

  /**
   * Get all pinned nodes.
   */
  getPinnedNodes(): PinnedNode[] {
    return Array.from(this.pinnedNodes.values());
  }

  /**
   * Check if there are any pinned nodes.
   */
  hasPinnedNodes(): boolean {
    return this.pinnedNodes.size > 0;
  }

  /**
   * Refresh context based on pinned nodes.
   */
  private async refreshContextFromPinnedNodes(): Promise<void> {
    if (this.pinnedNodes.size === 0) {
      this.stickyContext = null;
      this.currentContext = null;
      this.callbacks.onContextChange?.();
      return;
    }

    // Find the canvas for the pinned nodes
    const canvasPath = this.pinnedCanvasPath;
    if (!canvasPath) return;

    const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
    if (!canvasFile || !(canvasFile instanceof TFile)) {
      this.clearPinnedNodes();
      return;
    }

    // Try to get the canvas from workspace
    const canvas = this.findCanvasByPath(canvasPath);
    if (!canvas) {
      // Canvas not currently open - keep pinned nodes but can't build full context
      // We'll rebuild when the canvas is opened again
      return;
    }

    // Build context from pinned nodes
    const nodeContexts: NodeContext[] = [];
    const selectedNodes: CanvasNode[] = [];

    for (const pinnedNode of this.pinnedNodes.values()) {
      const node = this.findNodeById(canvas, pinnedNode.nodeId);
      if (node) {
        selectedNodes.push(node);
        const context = await this.buildNodeContext(node);
        if (context) {
          nodeContexts.push(context);
        }
      } else {
        // Node no longer exists in canvas - remove it
        this.pinnedNodes.delete(pinnedNode.nodeId);
      }
    }

    if (selectedNodes.length === 0) {
      this.clearPinnedNodes();
      return;
    }

    const formattedContext = this.formatContext(canvasFile as TFile, nodeContexts);

    this.stickyContext = {
      canvasFile: canvasFile as TFile,
      selectedNodes,
      nodeContexts,
      formattedContext,
    };
    this.currentContext = this.stickyContext;

    this.callbacks.onContextChange?.();
  }

  /**
   * Find a canvas by its file path.
   */
  private findCanvasByPath(path: string): Canvas | null {
    const leaves = this.app.workspace.getLeavesOfType('canvas');
    for (const leaf of leaves) {
      const view = leaf.view as any;
      if (view.file?.path === path && view.canvas) {
        return view.canvas;
      }
    }
    return null;
  }

  /**
   * Find a node by ID in a canvas.
   * Handles both array and Map implementations of canvas.nodes.
   */
  private findNodeById(canvas: Canvas, nodeId: string): CanvasNode | null {
    const nodes = canvas.nodes;
    
    // Handle Map-like structure (actual Obsidian internal API)
    if (nodes && typeof (nodes as unknown as Map<string, CanvasNode>).get === 'function') {
      return (nodes as unknown as Map<string, CanvasNode>).get(nodeId) ?? null;
    }
    
    // Handle array structure (as per type definition)
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (node.id === nodeId) {
          return node;
        }
      }
    }
    
    // Handle iterable (Set or similar)
    if (nodes && typeof nodes[Symbol.iterator] === 'function') {
      for (const node of nodes as Iterable<CanvasNode>) {
        if (node.id === nodeId) {
          return node;
        }
      }
    }
    
    return null;
  }

  /**
   * Build context for a single node including its ancestors.
   */
  private async buildNodeContext(node: CanvasNode): Promise<NodeContext | null> {
    try {
      const ancestors = await collectAncestors(node, this.maxAncestorDepth);
      const messages: NodeContext['messages'] = [];

      // The selected node is the one with depth 0 (last in the sorted list)
      const selectedNodeId = node.id;

      for (const ancestorNode of ancestors) {
        const content = await readNodeContent(ancestorNode);
        if (!content?.trim()) continue;

        const isCurrentNode = ancestorNode.id === selectedNodeId;

        // Skip system prompt nodes
        if (content.trim().toUpperCase().startsWith('SYSTEM PROMPT')) {
          messages.push({
            role: 'system',
            content: content.trim(),
            nodeId: ancestorNode.id,
            isCurrentNode,
          });
          continue;
        }

        const nodeData = ancestorNode.getData();
        const role = nodeData.chat_role === 'assistant' ? 'assistant' : 'user';

        messages.push({
          role,
          content: content.trim(),
          nodeId: ancestorNode.id,
          isCurrentNode,
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
   * Structure:
   * - Canvas header
   * - For each selected node:
   *   - Ancestor context (conversation history)
   *   - Current selected node (clearly marked)
   */
  private formatContext(canvasFile: TFile, nodeContexts: NodeContext[]): string {
    const parts: string[] = [];

    parts.push(`[Canvas: ${canvasFile.basename}]`);
    parts.push(`[Selected: ${nodeContexts.length} node(s)]`);
    parts.push('');

    for (let i = 0; i < nodeContexts.length; i++) {
      const ctx = nodeContexts[i];

      if (nodeContexts.length > 1) {
        parts.push(`=== Branch ${i + 1}: ${ctx.summary} ===`);
        parts.push('');
      }

      // Separate ancestor messages from current node
      const ancestorMessages = ctx.messages.filter(m => !m.isCurrentNode);
      const currentNodeMessages = ctx.messages.filter(m => m.isCurrentNode);

      // Format ancestor context (conversation history leading to the selected node)
      if (ancestorMessages.length > 0) {
        parts.push('<ancestor_context>');
        for (const msg of ancestorMessages) {
          const roleLabel = msg.role.toUpperCase();
          parts.push(`[${roleLabel}]`);
          parts.push(msg.content);
          parts.push('');
        }
        parts.push('</ancestor_context>');
        parts.push('');
      }

      // Format current selected node (the node user explicitly selected)
      if (currentNodeMessages.length > 0) {
        parts.push('<current_selected_node>');
        for (const msg of currentNodeMessages) {
          const roleLabel = msg.role.toUpperCase();
          parts.push(`[${roleLabel}]`);
          parts.push(msg.content);
        }
        parts.push('</current_selected_node>');
        parts.push('');
      }
    }

    return parts.join('\n').trim();
  }

  /**
   * Get a brief description of the current context for UI display.
   * Uses sticky context if no current selection.
   */
  getContextDescription(): string | null {
    const context = this.getCurrentContext();
    if (!context) return null;

    const { canvasFile, selectedNodes } = context;

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
    const previousContext = this.getCurrentContext();
    await this.refreshContext();
    const newContext = this.getCurrentContext();

    const hasChanged = this.hasContextChanged(previousContext, newContext);
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
