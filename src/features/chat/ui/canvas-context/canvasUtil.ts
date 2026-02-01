/**
 * Canvas utility functions for node traversal.
 * Based on obsidian-chat-stream implementation.
 */

import type { CanvasNode } from './canvas-internal';

export type HasId = {
  id: string;
};

export type NodeVisitor = (node: CanvasNode, depth: number) => Promise<boolean>;

/**
 * Get parent nodes for a canvas node.
 * Parents are nodes that have edges pointing TO this node.
 */
export function nodeParents(node: CanvasNode): CanvasNode[] {
  const canvas = node.canvas;
  const edges = canvas.getEdgesForNode(node);

  const nodes = edges
    .filter((edge) => edge.to.node.id === node.id)
    .map((edge) => edge.from.node);

  // Sort left-to-right for consistent ordering
  nodes.sort((a, b) => b.x - a.x);
  return nodes;
}

/**
 * Get child nodes for a canvas node.
 * Children are nodes that have edges pointing FROM this node.
 */
export function nodeChildren(node: CanvasNode): CanvasNode[] {
  const canvas = node.canvas;
  const edges = canvas.getEdgesForNode(node);

  const nodes = edges
    .filter((edge) => edge.from.node.id === node.id)
    .map((edge) => edge.to.node);

  // Sort left-to-right for consistent ordering
  nodes.sort((a, b) => a.x - b.x);
  return nodes;
}

/**
 * Visit node and its ancestors in breadth-first order.
 * The visitor function receives each node and its depth from the start node.
 * Return false from visitor to stop traversal.
 */
export async function visitNodeAndAncestors(
  start: CanvasNode,
  visitor: NodeVisitor,
  getNodeParents: (node: CanvasNode) => CanvasNode[] = nodeParents
): Promise<void> {
  const visited = new Set<string>();
  const queue: { node: CanvasNode; depth: number }[] = [{ node: start, depth: 0 }];

  while (queue.length > 0) {
    const { node: currentNode, depth } = queue.shift()!;

    if (visited.has(currentNode.id)) {
      continue;
    }

    const shouldContinue = await visitor(currentNode, depth);
    if (!shouldContinue) {
      break;
    }

    visited.add(currentNode.id);

    const parents = getNodeParents(currentNode);
    for (const parent of parents) {
      if (!visited.has(parent.id)) {
        queue.push({ node: parent, depth: depth + 1 });
      }
    }
  }
}

/**
 * Collect all ancestor nodes up to a maximum depth.
 * Returns nodes ordered from oldest ancestor to the start node.
 */
export async function collectAncestors(
  start: CanvasNode,
  maxDepth: number = 10
): Promise<CanvasNode[]> {
  const nodes: Array<{ node: CanvasNode; depth: number }> = [];

  await visitNodeAndAncestors(start, async (node, depth) => {
    if (depth > maxDepth) return false;
    nodes.push({ node, depth });
    return true;
  });

  // Sort by depth descending (oldest first), then by x position
  nodes.sort((a, b) => {
    if (a.depth !== b.depth) return b.depth - a.depth;
    return a.node.x - b.node.x;
  });

  return nodes.map((n) => n.node);
}
