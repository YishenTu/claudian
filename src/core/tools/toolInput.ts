/**
 * Tool input helpers.
 *
 * Keeps parsing of common tool inputs consistent across services.
 */

import {
  TOOL_EDIT,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LS,
  TOOL_NOTEBOOK_EDIT,
  TOOL_READ,
  TOOL_WRITE,
} from './toolNames';

export function getPathFromToolInput(
  toolName: string,
  toolInput: Record<string, unknown>
): string | null {
  switch (toolName) {
    case TOOL_READ:
    case TOOL_WRITE:
    case TOOL_EDIT:
    case TOOL_NOTEBOOK_EDIT:
      return (toolInput.file_path as string) || (toolInput.notebook_path as string) || null;
    case TOOL_GLOB:
      return (toolInput.path as string) || (toolInput.pattern as string) || null;
    case TOOL_GREP:
      return (toolInput.path as string) || null;
    case TOOL_LS:
      return (toolInput.path as string) || null;
    default:
      return null;
  }
}
