/**
 * Diff Tracking Hooks
 *
 * Pre/Post ToolUse hooks for capturing file content before and after edits.
 */

import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';

import { TOOL_EDIT, TOOL_WRITE } from '../tools/toolNames';
import type { ToolDiffData } from '../types';

/** Maximum file size for diff capture (100KB). */
export const MAX_DIFF_SIZE = 100 * 1024;

/** Callback for pre-edit tracking. */
export interface FileEditPreCallback {
  markFileBeingEdited(toolName: string, toolInput: Record<string, unknown>): Promise<void>;
}

/** Callback for post-edit tracking. */
export interface FileEditPostCallback {
  trackEditedFile(
    toolName: string | undefined,
    toolInput: Record<string, unknown> | undefined,
    isError: boolean
  ): Promise<void>;
}

/**
 * Storage for original file contents keyed by tool_use_id.
 */
export interface DiffContentEntry {
  filePath: string;
  content: string | null;
  skippedReason?: 'too_large' | 'unavailable';
}

/**
 * Create a PreToolUse hook to capture original file content before editing.
 */
export function createFileHashPreHook(
  vaultPath: string | null,
  originalContents: Map<string, DiffContentEntry>,
  preCallback?: FileEditPreCallback
): HookCallbackMatcher {
  return {
    matcher: 'Write|Edit|NotebookEdit',
    hooks: [
      async (hookInput, toolUseId) => {
        const input = hookInput as {
          tool_name: string;
          tool_input: Record<string, unknown>;
        };

        // Capture original content for diff (Write/Edit only, not NotebookEdit)
        if (input.tool_name === TOOL_WRITE || input.tool_name === TOOL_EDIT) {
          const rawPath = input.tool_input.file_path;
          const filePath = typeof rawPath === 'string' && rawPath ? rawPath : undefined;

          if (filePath && vaultPath && toolUseId) {
            const fullPath = path.isAbsolute(filePath)
              ? filePath
              : path.join(vaultPath, filePath);

            try {
              if (fs.existsSync(fullPath)) {
                const stats = fs.statSync(fullPath);
                if (stats.size <= MAX_DIFF_SIZE) {
                  const content = fs.readFileSync(fullPath, 'utf-8');
                  originalContents.set(toolUseId, { filePath, content });
                } else {
                  // File too large for diff
                  originalContents.set(toolUseId, { filePath, content: null, skippedReason: 'too_large' });
                }
              } else {
                // New file
                originalContents.set(toolUseId, { filePath, content: '' });
              }
            } catch {
              originalContents.set(toolUseId, { filePath, content: null, skippedReason: 'unavailable' });
            }
          }
        }

        await preCallback?.markFileBeingEdited(input.tool_name, input.tool_input);
        return { continue: true };
      },
    ],
  };
}

/**
 * Create a PostToolUse hook to capture post-edit content and compute diff.
 */
export function createFileHashPostHook(
  vaultPath: string | null,
  originalContents: Map<string, DiffContentEntry>,
  pendingDiffData: Map<string, ToolDiffData>,
  postCallback?: FileEditPostCallback
): HookCallbackMatcher {
  return {
    matcher: 'Write|Edit|NotebookEdit',
    hooks: [
      async (hookInput, toolUseId) => {
        const input = hookInput as {
          tool_name: string;
          tool_input: Record<string, unknown>;
          tool_result?: { is_error?: boolean };
        };
        const isError = input.tool_result?.is_error ?? false;

        // Compute diff for Write/Edit (if not error)
        if ((input.tool_name === TOOL_WRITE || input.tool_name === TOOL_EDIT) && toolUseId) {
          const originalEntry = originalContents.get(toolUseId);
          const rawPath = input.tool_input.file_path;
          const filePath =
            typeof rawPath === 'string' && rawPath ? rawPath : originalEntry?.filePath;

          if (!isError && filePath && vaultPath) {
            const fullPath = path.isAbsolute(filePath)
              ? filePath
              : path.join(vaultPath, filePath);

            let diffData: ToolDiffData | undefined;

            // If original was too large/unavailable, propagate skip reason
            if (originalEntry?.content === null) {
              diffData = { filePath, skippedReason: originalEntry.skippedReason ?? 'unavailable' };
            } else {
              try {
                if (fs.existsSync(fullPath)) {
                  const stats = fs.statSync(fullPath);
                  if (stats.size <= MAX_DIFF_SIZE) {
                    const newContent = fs.readFileSync(fullPath, 'utf-8');
                    if (originalEntry && originalEntry.content !== undefined) {
                      diffData = {
                        filePath,
                        originalContent: originalEntry.content,
                        newContent,
                      };
                    } else {
                      diffData = { filePath, skippedReason: 'unavailable' };
                    }
                  } else {
                    diffData = { filePath, skippedReason: 'too_large' };
                  }
                } else {
                  diffData = { filePath, skippedReason: 'unavailable' };
                }
              } catch {
                diffData = { filePath, skippedReason: 'unavailable' };
              }
            }

            if (diffData) {
              pendingDiffData.set(toolUseId, diffData);
            }
          }

          // Clean up original content map regardless of success/error
          originalContents.delete(toolUseId);
        }

        await postCallback?.trackEditedFile(input.tool_name, input.tool_input, isError);
        return { continue: true };
      },
    ],
  };
}
