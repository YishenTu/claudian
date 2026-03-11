import type { UsageInfo } from '../types';
import { getContextWindowSize } from '../types';
import type { TransformEvent } from './types';

export interface GeminiEvent {
  type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'thought' | 'error' | 'result';
  // init fields
  session_id?: string;
  model?: string;
  // message fields
  role?: 'user' | 'assistant';
  content?: string;
  delta?: boolean;
  // tool_use fields — Gemini CLI uses tool_name/tool_id/parameters
  tool_name?: string;
  tool_id?: string;
  parameters?: Record<string, unknown>;
  // Fallbacks for potential format variations
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  // tool_result fields
  output?: string;
  status?: string;
  is_error?: boolean;
  // error fields
  message?: string;
  // result fields
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    [key: string]: unknown;
  };
}

export interface TransformOptions {
  intendedModel?: string;
  customContextLimits?: Record<string, number>;
}

export function* transformGeminiEvent(
  event: GeminiEvent,
  options?: TransformOptions
): Generator<TransformEvent> {
  switch (event.type) {
    case 'init':
      yield {
        type: 'session_init',
        sessionId: event.session_id || '',
        agents: [],
        permissionMode: undefined,
      };
      break;

    case 'message':
      if (event.role === 'assistant') {
        const text = event.content || '';
        if (text) {
          yield { type: 'text', content: text, parentToolUseId: null };
        }
      }
      break;

    case 'thought':
      yield { type: 'thinking', content: event.content || '', parentToolUseId: null };
      break;

    case 'tool_use':
      yield {
        type: 'tool_use',
        id: event.tool_id || event.id || `tool-${Date.now()}`,
        name: event.tool_name || event.name || 'unknown',
        input: event.parameters || event.args || {},
        parentToolUseId: null,
      };
      break;

    case 'tool_result':
      yield {
        type: 'tool_result',
        id: event.tool_id || event.id || '',
        content: event.output || event.content || '',
        isError: event.is_error || event.status === 'error' || false,
        parentToolUseId: null,
      };
      break;

    case 'error':
      yield { type: 'error', content: event.message || event.content || 'Unknown error' };
      break;

    case 'result':
      if (event.stats) {
        const inputTokens = event.stats.input_tokens ?? 0;
        const model = options?.intendedModel ?? 'auto';
        const contextWindow = getContextWindowSize(model, options?.customContextLimits);
        const contextTokens = inputTokens;
        const percentage = Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)));

        const usageInfo: UsageInfo = {
          model,
          inputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          contextWindow,
          contextTokens,
          percentage,
        };
        yield { type: 'usage', usage: usageInfo };
      }
      break;

    default:
      break;
  }
}

export function parseGeminiJsonLine(line: string): GeminiEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as GeminiEvent;
  } catch {
    return null;
  }
}
