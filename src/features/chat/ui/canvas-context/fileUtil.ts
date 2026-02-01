/**
 * File utility functions for reading canvas node content.
 * Based on obsidian-chat-stream implementation.
 */

import type { App, TFile } from 'obsidian';
import { resolveSubpath } from 'obsidian';
import type { CanvasNode } from './canvas-internal';

/**
 * Read file content, optionally extracting a subpath (heading/block).
 */
export async function readFileContent(
  app: App,
  file: TFile,
  subpath?: string
): Promise<string> {
  const body = await app.vault.read(file);

  if (subpath) {
    const cache = app.metadataCache.getFileCache(file);
    if (cache) {
      const resolved = resolveSubpath(cache, subpath);
      if (resolved && (resolved.start || resolved.end)) {
        const subText = body.slice(resolved.start.offset, resolved.end?.offset);
        if (subText) {
          return subText;
        }
      }
    }
  }

  return body;
}

/**
 * Read the content of a canvas node.
 * Supports text nodes, file nodes (including images), and link nodes.
 */
export async function readNodeContent(node: CanvasNode): Promise<string | null> {
  const app = node.app;
  const nodeData = node.getData();

  switch (nodeData.type) {
    case 'text':
      return nodeData.text || null;

    case 'file': {
      const file = app.vault.getAbstractFileByPath(nodeData.file);
      if (!(file instanceof app.vault.adapter.constructor)) {
        // Check if it's a TFile
        const tfile = app.vault.getAbstractFileByPath(nodeData.file);
        if (tfile && 'extension' in tfile) {
          const ext = (tfile as TFile).extension;

          // Handle images - convert to base64
          if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
            try {
              const arrayBuffer = await app.vault.adapter.readBinary((tfile as TFile).path);
              const base64 = arrayBufferToBase64(arrayBuffer);
              return `[Image: ${(tfile as TFile).basename}] data:image/${ext};base64,${base64}`;
            } catch {
              return `[Image: ${(tfile as TFile).basename}]`;
            }
          }

          // Handle subpath if present
          if (nodeData.subpath) {
            return await readFileContent(app, tfile as TFile, nodeData.subpath);
          }

          // Read regular file content
          const body = await app.vault.read(tfile as TFile);
          return `## ${(tfile as TFile).basename}\n${body}`;
        }
      }
      return null;
    }

    case 'link':
      return nodeData.url ? `[Link: ${nodeData.url}]` : null;

    case 'group':
      return nodeData.label ? `[Group: ${nodeData.label}]` : null;

    default:
      return null;
  }
}

/**
 * Convert ArrayBuffer to base64 string.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Get a summary of the node for display purposes.
 */
export function getNodeSummary(node: CanvasNode, maxLength: number = 50): string {
  const nodeData = node.getData();

  switch (nodeData.type) {
    case 'text': {
      const text = nodeData.text?.trim() || '';
      if (text.length <= maxLength) return text;
      return text.slice(0, maxLength) + '...';
    }

    case 'file':
      return nodeData.file?.split('/').pop() || 'File';

    case 'link':
      return nodeData.url || 'Link';

    case 'group':
      return nodeData.label || 'Group';

    default:
      return 'Node';
  }
}
