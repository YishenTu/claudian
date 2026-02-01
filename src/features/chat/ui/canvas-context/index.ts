/**
 * Canvas Context Module
 *
 * Provides awareness of Canvas nodes for Claudian conversations.
 */

export type { Canvas, CanvasNode, CanvasEdge, CanvasView } from './canvas-internal';
export type { CanvasContext, NodeContext, CanvasContextCallbacks } from './CanvasContextManager';
export type { CanvasChipsViewCallbacks } from './CanvasChipsView';

export { CanvasContextManager } from './CanvasContextManager';
export { CanvasChipsView } from './CanvasChipsView';
export { visitNodeAndAncestors, collectAncestors, nodeParents, nodeChildren } from './canvasUtil';
export { readNodeContent, readFileContent, getNodeSummary } from './fileUtil';
