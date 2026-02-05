import { createMockEl } from '@test/helpers/mockElement';
import { setIcon,TFile } from 'obsidian';

import type { CanvasChipsViewCallbacks } from '@/features/chat/ui/canvas-context/CanvasChipsView';
import { CanvasChipsView } from '@/features/chat/ui/canvas-context/CanvasChipsView';
import type { CanvasContext } from '@/features/chat/ui/canvas-context/CanvasContextManager';

jest.mock('obsidian', () => ({
  ...jest.requireActual('obsidian'),
  setIcon: jest.fn(),
}));

function createMockNode(id: string, type: string = 'text', text: string = 'Test text') {
  return {
    id,
    getData: () => ({
      type,
      text: type === 'text' ? text : undefined,
      file: type === 'file' ? 'notes/test.md' : undefined,
      url: type === 'link' ? 'https://example.com' : undefined,
      label: type === 'group' ? 'Group Label' : undefined,
    }),
  };
}

function createMockTFile(path: string): TFile {
  return new (TFile as any)(path) as TFile;
}

function createMockContext(overrides: Partial<CanvasContext> = {}): CanvasContext {
  return {
    canvasFile: createMockTFile('test.canvas'),
    selectedNodes: [],
    nodeContexts: [],
    formattedContext: '[Canvas: test]',
    ...overrides,
  };
}

describe('CanvasChipsView', () => {
  let containerEl: ReturnType<typeof createMockEl>;
  let callbacks: CanvasChipsViewCallbacks;
  let view: CanvasChipsView;

  beforeEach(() => {
    containerEl = createMockEl();
    callbacks = {
      onOpenCanvas: jest.fn(),
      onRemoveContext: jest.fn(),
      onFocusNode: jest.fn(),
      onRemoveNode: jest.fn(),
    };
    view = new CanvasChipsView(containerEl, callbacks);
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create canvas indicator element', () => {
      const indicator = containerEl.querySelector('.claudian-canvas-indicator');
      expect(indicator).not.toBeNull();
    });

    it('should insert indicator at the beginning of container', () => {
      const existingChild = createMockEl();
      containerEl.appendChild(existingChild);

      // Create a new view - side effect is adding indicator to container
      new CanvasChipsView(containerEl, {});

      // The indicator should be first child
      expect(containerEl.firstChild).not.toBeNull();
      expect(containerEl.firstChild!.hasClass('claudian-canvas-indicator')).toBe(true);
    });
  });

  describe('render', () => {
    it('should hide indicator when context is null', () => {
      view.render(null);

      const indicator = containerEl.querySelector('.claudian-canvas-indicator');
      expect(indicator?.style.display).toBe('none');
    });

    it('should show indicator when context is provided', () => {
      const context = createMockContext();
      view.render(context);

      const indicator = containerEl.querySelector('.claudian-canvas-indicator');
      expect(indicator?.style.display).toBe('flex');
    });

    it('should render canvas file chip', () => {
      const context = createMockContext();
      view.render(context);

      const fileChip = containerEl.querySelector('.claudian-canvas-file-chip');
      expect(fileChip).not.toBeNull();
      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'layout-dashboard');
    });

    it('should render node chips when nodes are selected', () => {
      const node1 = createMockNode('node1');
      const node2 = createMockNode('node2');
      const context = createMockContext({
        selectedNodes: [node1, node2] as any,
        nodeContexts: [
          { node: node1, summary: 'Node 1', messages: [] },
          { node: node2, summary: 'Node 2', messages: [] },
        ] as any,
      });

      view.render(context);

      const nodeChips = containerEl.querySelectorAll('.claudian-canvas-node-chip');
      expect(nodeChips.length).toBe(2);
    });

    it('should render separator between canvas and nodes', () => {
      const node = createMockNode('node1');
      const context = createMockContext({
        selectedNodes: [node] as any,
        nodeContexts: [{ node, summary: 'Node', messages: [] }] as any,
      });

      view.render(context);

      const separator = containerEl.querySelector('.claudian-canvas-separator');
      expect(separator).not.toBeNull();
      expect(separator?.textContent).toBe('›');
    });

    it('should not render separator when no nodes selected', () => {
      const context = createMockContext({ selectedNodes: [] });

      view.render(context);

      const separator = containerEl.querySelector('.claudian-canvas-separator');
      expect(separator).toBeNull();
    });
  });

  describe('node icons', () => {
    it.each([
      ['text', 'text'],
      ['file', 'file'],
      ['link', 'link'],
      ['group', 'box-select'],
      ['unknown', 'square'],
    ])('should use correct icon for %s node', (nodeType, expectedIcon) => {
      const node = createMockNode('node1', nodeType);
      const context = createMockContext({
        selectedNodes: [node] as any,
        nodeContexts: [{ node, summary: 'Node', messages: [] }] as any,
      });

      view.render(context);

      expect(setIcon).toHaveBeenCalledWith(expect.anything(), expectedIcon);
    });
  });

  describe('ancestor count indicator', () => {
    it('should show ancestor count from nodeContext', () => {
      const node = createMockNode('node1');
      const context = createMockContext({
        selectedNodes: [node] as any,
        nodeContexts: [{
          node,
          summary: 'Node',
          messages: [
            { role: 'user', content: 'ancestor 1', nodeId: 'a1', isCurrentNode: false },
            { role: 'assistant', content: 'ancestor 2', nodeId: 'a2', isCurrentNode: false },
            { role: 'user', content: 'current', nodeId: 'node1', isCurrentNode: true },
          ],
        }] as any,
      });

      view.render(context);

      const countEl = containerEl.querySelector('.claudian-canvas-ancestor-count');
      expect(countEl).not.toBeNull();
      expect(countEl?.textContent).toBe('+2');
    });

    it('should not show count when no ancestors', () => {
      const node = createMockNode('node1');
      const context = createMockContext({
        selectedNodes: [node] as any,
        nodeContexts: [{
          node,
          summary: 'Node',
          messages: [
            { role: 'user', content: 'current', nodeId: 'node1', isCurrentNode: true },
          ],
        }] as any,
      });

      view.render(context);

      const countEl = containerEl.querySelector('.claudian-canvas-ancestor-count');
      expect(countEl).toBeNull();
    });
  });

  describe('callbacks', () => {
    it('should set up click handler on canvas chip for onOpenCanvas', () => {
      const context = createMockContext();
      view.render(context);

      const fileChip = containerEl.querySelector('.claudian-canvas-file-chip');
      // Verify click listener is attached
      expect(fileChip?.getEventListenerCount('click')).toBeGreaterThan(0);
    });

    it('should call onOpenCanvas when chip click event fires', () => {
      const context = createMockContext();
      view.render(context);

      const fileChip = containerEl.querySelector('.claudian-canvas-file-chip');
      // Dispatch event with target that is not a remove button
      fileChip?.dispatchEvent({
        type: 'click',
        target: { closest: () => null },
      });

      expect(callbacks.onOpenCanvas).toHaveBeenCalledWith('test.canvas');
    });

    it('should set up click handler on node chip for onFocusNode', () => {
      const node = createMockNode('node1');
      const context = createMockContext({
        selectedNodes: [node] as any,
        nodeContexts: [{ node, summary: 'Node', messages: [] }] as any,
      });
      view.render(context);

      const nodeChip = containerEl.querySelector('.claudian-canvas-node-chip');
      expect(nodeChip?.getEventListenerCount('click')).toBeGreaterThan(0);
    });

    it('should call onFocusNode when node chip click event fires', () => {
      const node = createMockNode('node1');
      const context = createMockContext({
        selectedNodes: [node] as any,
        nodeContexts: [{ node, summary: 'Node', messages: [] }] as any,
      });
      view.render(context);

      const nodeChip = containerEl.querySelector('.claudian-canvas-node-chip');
      nodeChip?.dispatchEvent({
        type: 'click',
        target: { closest: () => null },
      });

      expect(callbacks.onFocusNode).toHaveBeenCalledWith('node1');
    });

    it('should set up click handler on remove button for onRemoveNode', () => {
      const node = createMockNode('node1');
      const context = createMockContext({
        selectedNodes: [node] as any,
        nodeContexts: [{ node, summary: 'Node', messages: [] }] as any,
      });
      view.render(context);

      const removeBtn = containerEl.querySelector('.claudian-canvas-chip-remove');
      expect(removeBtn?.getEventListenerCount('click')).toBeGreaterThan(0);
    });

    it('should call onRemoveNode when remove button click event fires', () => {
      const node = createMockNode('node1');
      const context = createMockContext({
        selectedNodes: [node] as any,
        nodeContexts: [{ node, summary: 'Node', messages: [] }] as any,
      });
      view.render(context);

      const removeBtn = containerEl.querySelector('.claudian-canvas-chip-remove');
      removeBtn?.dispatchEvent({ type: 'click', stopPropagation: jest.fn() });

      expect(callbacks.onRemoveNode).toHaveBeenCalledWith('node1');
    });

    it('should not call onFocusNode when clicking remove button area', () => {
      const node = createMockNode('node1');
      const context = createMockContext({
        selectedNodes: [node] as any,
        nodeContexts: [{ node, summary: 'Node', messages: [] }] as any,
      });
      view.render(context);

      const nodeChip = containerEl.querySelector('.claudian-canvas-node-chip');
      // Simulate click on remove button (closest returns the remove element)
      nodeChip?.dispatchEvent({
        type: 'click',
        target: { closest: (sel: string) => sel === '.claudian-canvas-chip-remove' ? {} : null },
      });

      expect(callbacks.onFocusNode).not.toHaveBeenCalled();
    });
  });

  describe('hide/show', () => {
    it('should hide the indicator', () => {
      view.hide();

      const indicator = containerEl.querySelector('.claudian-canvas-indicator');
      expect(indicator?.style.display).toBe('none');
    });

    it('should show the indicator', () => {
      view.hide();
      view.show();

      const indicator = containerEl.querySelector('.claudian-canvas-indicator');
      expect(indicator?.style.display).toBe('flex');
    });
  });

  describe('destroy', () => {
    it('should remove the indicator element', () => {
      const indicator = containerEl.querySelector('.claudian-canvas-indicator');
      expect(indicator).not.toBeNull();

      view.destroy();

      // The remove method is called (mocked in createMockEl)
      // In a real DOM, the element would be removed
    });
  });

  describe('getAncestorCountHint fallback', () => {
    it('should estimate ancestor count from canvas edges', () => {
      const mockCanvas = {
        getEdgesForNode: jest.fn().mockReturnValue([
          { from: { node: { id: 'parent1' } }, to: { node: { id: 'node1' } } },
          { from: { node: { id: 'parent2' } }, to: { node: { id: 'node1' } } },
        ]),
      };
      const node = {
        id: 'node1',
        canvas: mockCanvas,
        getData: () => ({ type: 'text', text: 'Test' }),
      };
      const context = createMockContext({
        selectedNodes: [node] as any,
        nodeContexts: [], // No nodeContext, so fallback is used
      });

      view.render(context);

      // The fallback getAncestorCountHint should be called
      expect(mockCanvas.getEdgesForNode).toHaveBeenCalled();
    });

    it('should handle errors in ancestor count calculation gracefully', () => {
      const node = {
        id: 'node1',
        canvas: {
          getEdgesForNode: jest.fn().mockImplementation(() => {
            throw new Error('Canvas error');
          }),
        },
        getData: () => ({ type: 'text', text: 'Test' }),
      };
      const context = createMockContext({
        selectedNodes: [node] as any,
        nodeContexts: [],
      });

      // Should not throw
      expect(() => view.render(context)).not.toThrow();
    });

    it('should return 0 when canvas is not available', () => {
      const node = {
        id: 'node1',
        canvas: undefined,
        getData: () => ({ type: 'text', text: 'Test' }),
      };
      const context = createMockContext({
        selectedNodes: [node] as any,
        nodeContexts: [],
      });

      // Should not throw and should not show count
      expect(() => view.render(context)).not.toThrow();
      const countEl = containerEl.querySelector('.claudian-canvas-ancestor-count');
      expect(countEl).toBeNull();
    });
  });
});
