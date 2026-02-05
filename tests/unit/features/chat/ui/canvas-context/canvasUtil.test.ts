import {
  collectAncestors,
  nodeChildren,
  nodeParents,
  visitNodeAndAncestors,
} from '@/features/chat/ui/canvas-context/canvasUtil';

type MockCanvasNode = {
  id: string;
  x: number;
  canvas: {
    getEdgesForNode: (node: MockCanvasNode) => MockEdge[];
  };
};

type MockEdge = {
  from: { node: MockCanvasNode };
  to: { node: MockCanvasNode };
};

function createMockCanvas() {
  const edges: MockEdge[] = [];

  const canvas = {
    getEdgesForNode: (node: MockCanvasNode) => {
      return edges.filter(e => e.from.node.id === node.id || e.to.node.id === node.id);
    },
  };

  const createNode = (id: string, x: number = 0): MockCanvasNode => ({
    id,
    x,
    canvas,
  });

  const addEdge = (from: MockCanvasNode, to: MockCanvasNode) => {
    edges.push({ from: { node: from }, to: { node: to } });
  };

  return { canvas, createNode, addEdge, edges };
}

describe('canvasUtil', () => {
  describe('nodeParents', () => {
    it('should return empty array for node with no parents', () => {
      const { createNode } = createMockCanvas();
      const node = createNode('a');

      const parents = nodeParents(node as any);
      expect(parents).toEqual([]);
    });

    it('should return parent nodes', () => {
      const { createNode, addEdge } = createMockCanvas();
      const parent = createNode('parent', 0);
      const child = createNode('child', 100);
      addEdge(parent, child);

      const parents = nodeParents(child as any);
      expect(parents).toHaveLength(1);
      expect(parents[0].id).toBe('parent');
    });

    it('should return multiple parents sorted by x position (descending)', () => {
      const { createNode, addEdge } = createMockCanvas();
      const parent1 = createNode('p1', 0);
      const parent2 = createNode('p2', 100);
      const parent3 = createNode('p3', 50);
      const child = createNode('child', 200);
      addEdge(parent1, child);
      addEdge(parent2, child);
      addEdge(parent3, child);

      const parents = nodeParents(child as any);
      expect(parents).toHaveLength(3);
      // Sorted descending by x: p2 (100), p3 (50), p1 (0)
      expect(parents.map(p => p.id)).toEqual(['p2', 'p3', 'p1']);
    });

    it('should not return children as parents', () => {
      const { createNode, addEdge } = createMockCanvas();
      const parent = createNode('parent', 0);
      const child = createNode('child', 100);
      addEdge(parent, child);

      const parentOfParent = nodeParents(parent as any);
      expect(parentOfParent).toEqual([]);
    });
  });

  describe('nodeChildren', () => {
    it('should return empty array for node with no children', () => {
      const { createNode } = createMockCanvas();
      const node = createNode('a');

      const children = nodeChildren(node as any);
      expect(children).toEqual([]);
    });

    it('should return child nodes', () => {
      const { createNode, addEdge } = createMockCanvas();
      const parent = createNode('parent', 0);
      const child = createNode('child', 100);
      addEdge(parent, child);

      const children = nodeChildren(parent as any);
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe('child');
    });

    it('should return multiple children sorted by x position (ascending)', () => {
      const { createNode, addEdge } = createMockCanvas();
      const parent = createNode('parent', 0);
      const child1 = createNode('c1', 200);
      const child2 = createNode('c2', 100);
      const child3 = createNode('c3', 150);
      addEdge(parent, child1);
      addEdge(parent, child2);
      addEdge(parent, child3);

      const children = nodeChildren(parent as any);
      expect(children).toHaveLength(3);
      // Sorted ascending by x: c2 (100), c3 (150), c1 (200)
      expect(children.map(c => c.id)).toEqual(['c2', 'c3', 'c1']);
    });
  });

  describe('visitNodeAndAncestors', () => {
    it('should visit start node first', async () => {
      const { createNode } = createMockCanvas();
      const node = createNode('a');
      const visited: string[] = [];

      await visitNodeAndAncestors(node as any, async (n, depth) => {
        visited.push(`${n.id}:${depth}`);
        return true;
      });

      expect(visited).toEqual(['a:0']);
    });

    it('should visit ancestors in breadth-first order', async () => {
      const { createNode, addEdge } = createMockCanvas();
      const grandparent = createNode('gp', 0);
      const parent = createNode('p', 100);
      const child = createNode('c', 200);
      addEdge(grandparent, parent);
      addEdge(parent, child);

      const visited: string[] = [];
      await visitNodeAndAncestors(child as any, async (n, depth) => {
        visited.push(`${n.id}:${depth}`);
        return true;
      });

      expect(visited).toEqual(['c:0', 'p:1', 'gp:2']);
    });

    it('should stop traversal when visitor returns false', async () => {
      const { createNode, addEdge } = createMockCanvas();
      const grandparent = createNode('gp', 0);
      const parent = createNode('p', 100);
      const child = createNode('c', 200);
      addEdge(grandparent, parent);
      addEdge(parent, child);

      const visited: string[] = [];
      await visitNodeAndAncestors(child as any, async (n, depth) => {
        visited.push(n.id);
        return depth < 1; // Stop after first parent
      });

      expect(visited).toEqual(['c', 'p']);
    });

    it('should not visit the same node twice (handles cycles)', async () => {
      const { createNode, addEdge } = createMockCanvas();
      const nodeA = createNode('a', 0);
      const nodeB = createNode('b', 100);
      // Create a cycle: A -> B -> A
      addEdge(nodeA, nodeB);
      addEdge(nodeB, nodeA);

      const visited: string[] = [];
      await visitNodeAndAncestors(nodeB as any, async (n) => {
        visited.push(n.id);
        return true;
      });

      // Each node should only be visited once
      expect(visited).toContain('b');
      expect(visited).toContain('a');
      expect(visited.length).toBe(2);
    });

    it('should allow custom parent getter', async () => {
      const { createNode } = createMockCanvas();
      const nodeA = createNode('a');
      const nodeB = createNode('b');
      const nodeC = createNode('c');

      const customParents = new Map<string, MockCanvasNode[]>([
        ['a', []],
        ['b', [nodeA]],
        ['c', [nodeB]],
      ]);

      const visited: string[] = [];
      await visitNodeAndAncestors(
        nodeC as any,
        async (n) => {
          visited.push(n.id);
          return true;
        },
        (n) => (customParents.get(n.id) || []) as any
      );

      expect(visited).toEqual(['c', 'b', 'a']);
    });
  });

  describe('collectAncestors', () => {
    it('should return only start node when no ancestors', async () => {
      const { createNode } = createMockCanvas();
      const node = createNode('a');

      const ancestors = await collectAncestors(node as any);
      expect(ancestors).toHaveLength(1);
      expect(ancestors[0].id).toBe('a');
    });

    it('should return ancestors ordered from oldest to start node', async () => {
      const { createNode, addEdge } = createMockCanvas();
      const grandparent = createNode('gp', 0);
      const parent = createNode('p', 100);
      const child = createNode('c', 200);
      addEdge(grandparent, parent);
      addEdge(parent, child);

      const ancestors = await collectAncestors(child as any);
      expect(ancestors.map(a => a.id)).toEqual(['gp', 'p', 'c']);
    });

    it('should respect maxDepth limit', async () => {
      const { createNode, addEdge } = createMockCanvas();
      const n1 = createNode('n1', 0);
      const n2 = createNode('n2', 100);
      const n3 = createNode('n3', 200);
      const n4 = createNode('n4', 300);
      addEdge(n1, n2);
      addEdge(n2, n3);
      addEdge(n3, n4);

      const ancestors = await collectAncestors(n4 as any, 2);
      // maxDepth=2 means we collect n4 (0), n3 (1), n2 (2), but not n1 (3)
      expect(ancestors.map(a => a.id)).toEqual(['n2', 'n3', 'n4']);
    });

    it('should handle diamond pattern (multiple paths to same ancestor)', async () => {
      const { createNode, addEdge } = createMockCanvas();
      //     root
      //    /    \
      //   a      b
      //    \    /
      //     child
      const root = createNode('root', 50);
      const a = createNode('a', 0);
      const b = createNode('b', 100);
      const child = createNode('child', 50);
      addEdge(root, a);
      addEdge(root, b);
      addEdge(a, child);
      addEdge(b, child);

      const ancestors = await collectAncestors(child as any);
      const ids = ancestors.map(n => n.id);

      // All nodes should be included exactly once
      expect(ids).toContain('root');
      expect(ids).toContain('a');
      expect(ids).toContain('b');
      expect(ids).toContain('child');
      expect(ancestors.length).toBe(4);

      // child should be last (depth 0)
      expect(ids[ids.length - 1]).toBe('child');
    });

    it('should sort same-depth nodes by x position', async () => {
      const { createNode, addEdge } = createMockCanvas();
      const root = createNode('root', 50);
      const leftParent = createNode('left', 0);
      const rightParent = createNode('right', 100);
      const child = createNode('child', 50);
      addEdge(root, leftParent);
      addEdge(root, rightParent);
      addEdge(leftParent, child);
      addEdge(rightParent, child);

      const ancestors = await collectAncestors(child as any);
      const ids = ancestors.map(n => n.id);

      // root is at depth 2
      // leftParent and rightParent are at depth 1, should be sorted by x
      // child is at depth 0
      expect(ids[0]).toBe('root');
      // left (x=0) should come before right (x=100) at same depth
      expect(ids.indexOf('left')).toBeLessThan(ids.indexOf('right'));
      expect(ids[ids.length - 1]).toBe('child');
    });
  });
});
