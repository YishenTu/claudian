import type { CodexDynamicToolRegistration } from './CodexDynamicToolRegistry';
import type { CodexRuntimeContext } from './CodexRuntimeContext';
import {
  formatCodexWorkspaceDependencies,
  resolveCodexWorkspaceDependencies,
} from './CodexWorkspaceDependencyResolver';

export const CODEX_WORKSPACE_DEPENDENCY_TOOL_NAMESPACE = 'codex_app';
export const CODEX_WORKSPACE_DEPENDENCY_TOOL_NAME = 'load_workspace_dependencies';
export const CODEX_WORKSPACE_DEPENDENCY_TOOL_VERSION = 1;

export function createCodexWorkspaceDependencyTool(
  context: CodexRuntimeContext,
): CodexDynamicToolRegistration {
  return {
    includeInThreadStart: true,
    namespace: {
      name: CODEX_WORKSPACE_DEPENDENCY_TOOL_NAMESPACE,
      description: 'Tools provided by the Claudian Codex host.',
    },
    tool: {
      type: 'function',
      name: CODEX_WORKSPACE_DEPENDENCY_TOOL_NAME,
      description: 'Locate the configured bundled workspace dependency runtime paths for this local Claudian Codex thread, including Node.js, Python, and useful libraries for working with spreadsheets, slide decks, Word documents, and PDFs. This is read-only and takes no arguments.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: async (params) => {
      if (
        params.arguments
        && typeof params.arguments === 'object'
        && !Array.isArray(params.arguments)
        && Object.keys(params.arguments).length > 0
      ) {
        return {
          success: false,
          contentItems: [{
            type: 'inputText',
            text: `${CODEX_WORKSPACE_DEPENDENCY_TOOL_NAME} does not accept arguments.`,
          }],
        };
      }

      const dependencies = await resolveCodexWorkspaceDependencies(context);
      if (!dependencies) {
        return {
          success: false,
          contentItems: [{
            type: 'inputText',
            text: 'The bundled Codex workspace dependency runtime is unavailable. Report this as a blocker and do not guess or install replacement dependencies.',
          }],
        };
      }

      return {
        success: true,
        contentItems: [{
          type: 'inputText',
          text: formatCodexWorkspaceDependencies(dependencies),
        }],
      };
    },
  };
}
