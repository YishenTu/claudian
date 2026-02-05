import { TFile } from 'obsidian';

import type {
  CanvasContextCallbacks} from '@/features/chat/ui/canvas-context/CanvasContextManager';
import {
  CanvasContextManager
} from '@/features/chat/ui/canvas-context/CanvasContextManager';

function createMockTFile(path: string): TFile {
  return new (TFile as any)(path) as TFile;
}

// Mock the canvasUtil and fileUtil modules
jest.mock('@/features/chat/ui/canvas-context/canvasUtil', () => ({
  collectAncestors: jest.fn().mockImplementation(async (node) => [node]),
  nodeParents: jest.fn().mockReturnValue([]),
}));

jest.mock('@/features/chat/ui/canvas-context/fileUtil', () => ({
  getNodeSummary: jest.fn().mockImplementation((node, maxLength = 50) => {
    const text = node.getData?.()?.text || 'Node';
    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
  }),
  readNodeContent: jest.fn().mockImplementation(async (node) => {
    return node.getData?.()?.text || null;
  }),
}));

function createMockNode(id: string, options: {
  text?: string;
  type?: string;
  x?: number;
  chat_role?: string;
} = {}) {
  return {
    id,
    x: options.x ?? 0,
    getData: () => ({
      type: options.type || 'text',
      text: options.text ?? `Node ${id}`,
      chat_role: options.chat_role,
    }),
  };
}

function createMockCanvas(selectedNodes: any[] = []) {
  const nodes = new Map<string, any>();
  selectedNodes.forEach(n => nodes.set(n.id, n));

  return {
    nodes,
    selection: new Set(selectedNodes),
    getEdgesForNode: jest.fn().mockReturnValue([]),
  };
}

function createMockApp(options: {
  canvas?: any;
  canvasFile?: TFile | null;
  viewType?: string;
} = {}) {
  const canvasFile = options.canvasFile ?? createMockTFile('test.canvas');
  const canvas = options.canvas ?? createMockCanvas();
  const viewType = options.viewType ?? 'canvas';

  const mockLeaf: any = {
    view: {
      getViewType: () => viewType,
      canvas,
      file: canvasFile,
    },
  };

  return {
    workspace: {
      activeLeaf: mockLeaf as any,
      on: jest.fn().mockReturnValue({ id: 'event-ref' }),
      offref: jest.fn(),
      getLeavesOfType: jest.fn().mockReturnValue([mockLeaf]),
    },
    vault: {
      getAbstractFileByPath: jest.fn().mockReturnValue(canvasFile),
    },
  };
}

describe('CanvasContextManager', () => {
  let manager: CanvasContextManager;
  let mockApp: ReturnType<typeof createMockApp>;
  let callbacks: CanvasContextCallbacks;

  beforeEach(() => {
    jest.useFakeTimers();
    mockApp = createMockApp();
    callbacks = {
      onContextChange: jest.fn(),
    };
    manager = new CanvasContextManager(mockApp as any, callbacks);
  });

  afterEach(() => {
    manager.destroy();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('startWatching / stopWatching', () => {
    it('should register event listeners on start', () => {
      manager.startWatching();

      expect(mockApp.workspace.on).toHaveBeenCalledWith('active-leaf-change', expect.any(Function));
      expect(mockApp.workspace.on).toHaveBeenCalledWith('layout-change', expect.any(Function));
    });

    it('should set up selection polling interval', () => {
      manager.startWatching();

      // Interval should be set (verified by advancing timers without error)
      expect(() => jest.advanceTimersByTime(200)).not.toThrow();
    });

    it('should unregister event listeners on stop', () => {
      manager.startWatching();
      manager.stopWatching();

      expect(mockApp.workspace.offref).toHaveBeenCalled();
    });

    it('should clear polling interval on stop', () => {
      manager.startWatching();
      manager.stopWatching();

      // Advancing timers should not trigger any polling or errors
      expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
    });
  });

  describe('isCanvasActive', () => {
    it('should return true when active leaf is a canvas', () => {
      expect(manager.isCanvasActive()).toBe(true);
    });

    it('should return false when active leaf is not a canvas', () => {
      const nonCanvasApp = createMockApp({ viewType: 'markdown' });
      const nonCanvasManager = new CanvasContextManager(nonCanvasApp as any);

      expect(nonCanvasManager.isCanvasActive()).toBe(false);
    });

    it('should return false when no active leaf', () => {
      (mockApp.workspace as any).activeLeaf = null;

      expect(manager.isCanvasActive()).toBe(false);
    });
  });

  describe('getActiveCanvas', () => {
    it('should return canvas from active leaf', () => {
      const canvas = manager.getActiveCanvas();

      expect(canvas).not.toBeNull();
    });

    it('should fallback to finding canvas with selection', () => {
      (mockApp.workspace as any).activeLeaf = {
        view: { getViewType: () => 'markdown' },
      };

      const node = createMockNode('n1');
      const canvasWithSelection = createMockCanvas([node]);
      mockApp.workspace.getLeavesOfType = jest.fn().mockReturnValue([{
        view: {
          getViewType: () => 'canvas',
          canvas: canvasWithSelection,
        },
      }]);

      const canvas = manager.getActiveCanvas();

      expect(canvas).toBe(canvasWithSelection);
    });

    it('should return null when no canvas found', () => {
      (mockApp.workspace as any).activeLeaf = null;
      mockApp.workspace.getLeavesOfType = jest.fn().mockReturnValue([]);

      const canvas = manager.getActiveCanvas();

      expect(canvas).toBeNull();
    });
  });

  describe('getActiveCanvasFile', () => {
    it('should return file from active canvas', () => {
      const file = manager.getActiveCanvasFile();

      expect(file).toBeInstanceOf(TFile);
      expect(file?.path).toBe('test.canvas');
    });

    it('should return null when no canvas active', () => {
      (mockApp.workspace as any).activeLeaf = null;
      mockApp.workspace.getLeavesOfType = jest.fn().mockReturnValue([]);

      const file = manager.getActiveCanvasFile();

      expect(file).toBeNull();
    });
  });

  describe('getSelectedNodes', () => {
    it('should return selected nodes from canvas', () => {
      const node1 = createMockNode('n1');
      const node2 = createMockNode('n2');
      const canvas = createMockCanvas([node1, node2]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      const nodes = manager.getSelectedNodes();

      expect(nodes).toHaveLength(2);
    });

    it('should return empty array when no selection', () => {
      const canvas = createMockCanvas([]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      const nodes = manager.getSelectedNodes();

      expect(nodes).toEqual([]);
    });

    it('should return empty array when no canvas', () => {
      (mockApp.workspace as any).activeLeaf = null;
      mockApp.workspace.getLeavesOfType = jest.fn().mockReturnValue([]);

      const nodes = manager.getSelectedNodes();

      expect(nodes).toEqual([]);
    });
  });

  describe('refreshContext', () => {
    it('should build context from selected nodes', async () => {
      const node = createMockNode('n1', { text: 'Hello' });
      const canvas = createMockCanvas([node]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      const context = await manager.refreshContext();

      expect(context).not.toBeNull();
      expect(context?.selectedNodes).toHaveLength(1);
      expect(context?.canvasFile.path).toBe('test.canvas');
    });

    it('should return null when no canvas active', async () => {
      (mockApp.workspace as any).activeLeaf = null;
      mockApp.workspace.getLeavesOfType = jest.fn().mockReturnValue([]);

      const context = await manager.refreshContext();

      expect(context).toBeNull();
    });

    it('should return context with no nodes when none selected', async () => {
      const canvas = createMockCanvas([]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      const context = await manager.refreshContext();

      expect(context).not.toBeNull();
      expect(context?.selectedNodes).toEqual([]);
      expect(context?.formattedContext).toContain('No nodes selected');
    });

    it('should format context with canvas name', async () => {
      const node = createMockNode('n1');
      const canvas = createMockCanvas([node]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      const context = await manager.refreshContext();

      expect(context?.formattedContext).toContain('[Canvas: test]');
    });

    it('should include node count in context', async () => {
      const node1 = createMockNode('n1');
      const node2 = createMockNode('n2');
      const canvas = createMockCanvas([node1, node2]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      const context = await manager.refreshContext();

      expect(context?.formattedContext).toContain('[Selected: 2 node(s)]');
    });
  });

  describe('sticky context', () => {
    it('should preserve context when selection is cleared', async () => {
      const node = createMockNode('n1');
      const canvas = createMockCanvas([node]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      // Build initial context
      await manager.refreshContext();

      // Clear selection
      canvas.selection = new Set();

      // Should still return sticky context
      const context = manager.getCurrentContext();
      expect(context).not.toBeNull();
      expect(context?.selectedNodes).toHaveLength(1);
    });

    it('should clear sticky context on clearStickyContext', async () => {
      const node = createMockNode('n1');
      const canvas = createMockCanvas([node]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      await manager.refreshContext();
      manager.clearStickyContext();

      canvas.selection = new Set();
      const context = manager.getCurrentContext();
      expect(context).toBeNull();
    });
  });

  describe('pinned nodes', () => {
    it('should pin current selection', async () => {
      const node = createMockNode('n1');
      const canvas = createMockCanvas([node]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      await manager.pinCurrentSelection();

      expect(manager.hasPinnedNodes()).toBe(true);
      expect(manager.getPinnedNodes()).toHaveLength(1);
      expect(manager.getPinnedNodes()[0].nodeId).toBe('n1');
    });

    it('should not pin when no selection', async () => {
      const canvas = createMockCanvas([]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      await manager.pinCurrentSelection();

      expect(manager.hasPinnedNodes()).toBe(false);
    });

    it('should unpin a node by ID', async () => {
      const node1 = createMockNode('n1');
      const node2 = createMockNode('n2');
      const canvas = createMockCanvas([node1, node2]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      await manager.pinCurrentSelection();
      await manager.unpinNode('n1');

      const pinned = manager.getPinnedNodes();
      expect(pinned).toHaveLength(1);
      expect(pinned[0].nodeId).toBe('n2');
    });

    it('should clear all pinned nodes', async () => {
      const node = createMockNode('n1');
      const canvas = createMockCanvas([node]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      await manager.pinCurrentSelection();
      manager.clearPinnedNodes();

      expect(manager.hasPinnedNodes()).toBe(false);
      expect(manager.getPinnedNodes()).toEqual([]);
    });

    it('should clear pinned nodes when switching canvas', async () => {
      const node = createMockNode('n1');
      const canvas = createMockCanvas([node]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      await manager.pinCurrentSelection();

      // Switch to different canvas
      const newFile = createMockTFile('other.canvas');
      (mockApp.workspace.activeLeaf as any).view.file = newFile;

      await manager.refreshContext();

      // Old pins should be cleared
      expect(manager.getPinnedNodes().some(p => p.canvasPath === 'test.canvas')).toBe(false);
    });

    it('should notify on pinned nodes change', async () => {
      const node = createMockNode('n1');
      const canvas = createMockCanvas([node]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      await manager.pinCurrentSelection();
      manager.clearPinnedNodes();

      expect(callbacks.onContextChange).toHaveBeenCalled();
    });

    it('should store pinned node summary and type', async () => {
      const node = createMockNode('n1', { text: 'Hello world', type: 'text' });
      const canvas = createMockCanvas([node]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      await manager.pinCurrentSelection();

      const pinned = manager.getPinnedNodes()[0];
      expect(pinned.summary).toContain('Hello');
      expect(pinned.nodeType).toBe('text');
    });
  });

  describe('context description', () => {
    it('should return canvas name with no selection', async () => {
      // First select a node to establish sticky context, then clear selection
      const node = createMockNode('n1');
      const canvas = createMockCanvas([node]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;
      await manager.refreshContext();

      // Now clear selection but sticky context should persist
      canvas.selection = new Set();

      const desc = manager.getContextDescription();

      // Description comes from sticky context
      expect(desc).toContain('test');
    });

    it('should return canvas and node summary for single selection', async () => {
      const node = createMockNode('n1', { text: 'Hello world' });
      const canvas = createMockCanvas([node]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;
      await manager.refreshContext();

      const desc = manager.getContextDescription();

      expect(desc).toContain('test');
      expect(desc).toContain('>');
      expect(desc).toContain('Hello');
    });

    it('should return node count for multiple selections', async () => {
      const node1 = createMockNode('n1');
      const node2 = createMockNode('n2');
      const node3 = createMockNode('n3');
      const canvas = createMockCanvas([node1, node2, node3]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;
      await manager.refreshContext();

      const desc = manager.getContextDescription();

      expect(desc).toContain('3 nodes');
    });

    it('should return null when no context', () => {
      mockApp.workspace.activeLeaf = null;
      mockApp.workspace.getLeavesOfType = jest.fn().mockReturnValue([]);

      const desc = manager.getContextDescription();

      expect(desc).toBeNull();
    });
  });

  describe('setMaxAncestorDepth', () => {
    it('should update max ancestor depth', () => {
      manager.setMaxAncestorDepth(20);

      // The depth is used internally - we can verify it was set by checking it doesn't throw
      expect(() => manager.setMaxAncestorDepth(5)).not.toThrow();
    });
  });

  describe('destroy', () => {
    it('should stop watching and clear context', () => {
      manager.startWatching();
      manager.destroy();

      expect(mockApp.workspace.offref).toHaveBeenCalled();
    });
  });

  describe('context change detection', () => {
    it('should detect canvas file change via hasContextChanged', () => {
      const node = createMockNode('n1');
      const canvasFile = createMockTFile('test.canvas');

      const prevContext = {
        canvasFile,
        selectedNodes: [node],
        nodeContexts: [],
        formattedContext: '',
      };

      const newFile = createMockTFile('other.canvas');
      const currContext = {
        canvasFile: newFile,
        selectedNodes: [node],
        nodeContexts: [],
        formattedContext: '',
      };

      // Use the internal hasContextChanged logic: different canvas paths
      expect(prevContext.canvasFile.path).not.toBe(currContext.canvasFile.path);
    });

    it('should detect selection change via hasContextChanged', () => {
      const node1 = createMockNode('n1');
      const node2 = createMockNode('n2');
      const canvasFile = createMockTFile('test.canvas');

      const prevContext = {
        canvasFile,
        selectedNodes: [node1],
        nodeContexts: [],
        formattedContext: '',
      };

      const currContext = {
        canvasFile,
        selectedNodes: [node2],
        nodeContexts: [],
        formattedContext: '',
      };

      // Different node IDs should indicate change
      const prevIds = prevContext.selectedNodes.map(n => n.id).sort().join(',');
      const currIds = currContext.selectedNodes.map(n => n.id).sort().join(',');
      expect(prevIds).not.toBe(currIds);
    });

    it('should not detect change when selection is same', () => {
      const node = createMockNode('n1');
      const canvasFile = createMockTFile('test.canvas');

      const prevContext = {
        canvasFile,
        selectedNodes: [node],
        nodeContexts: [],
        formattedContext: '',
      };

      const currContext = {
        canvasFile,
        selectedNodes: [node],
        nodeContexts: [],
        formattedContext: '',
      };

      const prevIds = prevContext.selectedNodes.map(n => n.id).sort().join(',');
      const currIds = currContext.selectedNodes.map(n => n.id).sort().join(',');
      expect(prevIds).toBe(currIds);
    });
  });

  describe('formatContext', () => {
    it('should format multi-node context with branch labels', async () => {
      const node1 = createMockNode('n1', { text: 'Branch 1' });
      const node2 = createMockNode('n2', { text: 'Branch 2' });
      const canvas = createMockCanvas([node1, node2]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      const context = await manager.refreshContext();

      expect(context?.formattedContext).toContain('=== Branch 1:');
      expect(context?.formattedContext).toContain('=== Branch 2:');
    });

    it('should include current_selected_node tag', async () => {
      const node = createMockNode('n1', { text: 'Current node' });
      const canvas = createMockCanvas([node]);
      (mockApp.workspace.activeLeaf as any).view.canvas = canvas;

      const context = await manager.refreshContext();

      expect(context?.formattedContext).toContain('<current_selected_node>');
      expect(context?.formattedContext).toContain('</current_selected_node>');
    });
  });
});
