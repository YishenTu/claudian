import type { ProviderTaskResultInterpreter } from '../../../core/providers/types';
import type { ToolCallInfo } from '../../../core/types';

/**
 * ACP task result interpreter.
 * ACP doesn't use the same async agent pattern as Claude, so most methods are no-ops.
 */
export class AcpTaskResultInterpreter implements ProviderTaskResultInterpreter {
  hasAsyncLaunchMarker(toolUseResult: unknown): boolean {
    // ACP doesn't have async launch markers
    return false;
  }

  extractAgentId(toolUseResult: unknown): string | null {
    // ACP doesn't use agent IDs in the same way
    return null;
  }

  extractStructuredResult(toolUseResult: unknown): string | null {
    // Try to extract a structured result from the tool output
    if (toolUseResult && typeof toolUseResult === 'object') {
      const result = toolUseResult as Record<string, unknown>;
      if (typeof result.result === 'string') {
        return result.result;
      }
    }
    return null;
  }

  resolveTerminalStatus(
    _toolUseResult: unknown,
    fallbackStatus: 'completed' | 'error',
  ): 'completed' | 'error' {
    return fallbackStatus;
  }

  extractTagValue(payload: string, tagName: string): string | null {
    // Extract a tag value from the payload (e.g., <tag>value</tag>)
    const regex = new RegExp(`<${tagName}>([^<]*)</${tagName}>`, 's');
    const match = payload.match(regex);
    return match ? match[1].trim() : null;
  }
}
