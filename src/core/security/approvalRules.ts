/** Permission utilities for tool action approval. */

import {
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_NOTEBOOK_EDIT,
  TOOL_READ,
  TOOL_WRITE,
} from '../tools/toolNames';

export function getActionPattern(toolName: string, input: Record<string, unknown>): string | null {
  switch (toolName) {
    case TOOL_BASH:
      return typeof input.command === 'string' ? input.command.trim() : '';
    case TOOL_READ:
    case TOOL_WRITE:
    case TOOL_EDIT:
      return typeof input.file_path === 'string' && input.file_path ? input.file_path : null;
    case TOOL_NOTEBOOK_EDIT:
      if (typeof input.notebook_path === 'string' && input.notebook_path) {
        return input.notebook_path;
      }
      return typeof input.file_path === 'string' && input.file_path ? input.file_path : null;
    case TOOL_GLOB:
      return typeof input.pattern === 'string' && input.pattern ? input.pattern : null;
    case TOOL_GREP:
      return typeof input.pattern === 'string' && input.pattern ? input.pattern : null;
    default:
      return JSON.stringify(input);
  }
}

export function getActionDescription(toolName: string, input: Record<string, unknown>): string {
  const pattern = getActionPattern(toolName, input) ?? '(unknown)';
  switch (toolName) {
    case TOOL_BASH:
      return `Run command: ${pattern}`;
    case TOOL_READ:
      return `Read file: ${pattern}`;
    case TOOL_WRITE:
      return `Write to file: ${pattern}`;
    case TOOL_EDIT:
      return `Edit file: ${pattern}`;
    case TOOL_GLOB:
      return `Search files matching: ${pattern}`;
    case TOOL_GREP:
      return `Search content matching: ${pattern}`;
    default:
      return `${toolName}: ${pattern}`;
  }
}
