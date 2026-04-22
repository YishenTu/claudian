import type { SDKMessage, SDKResultError } from '@anthropic-ai/claude-agent-sdk';

import type { SDKToolUseResult, StreamChunk, UsageInfo } from '../../../core/types';
import { isBlockedMessage } from '../sdk/messages';
import { extractToolResultContent } from '../sdk/toolResultContent';
import type { TransformEvent } from '../sdk/types';
import { getContextWindowSize, isDefaultClaudeModel } from '../types/models';
import { createTransformStreamState, type TransformStreamState } from './toolInputStreamState';

type ToolUseFields = { id: string; name: string; input: Record<string, unknown> };
type ToolResultFields = { id: string; content: string; isError?: boolean; toolUseResult?: SDKToolUseResult };

export { createTransformStreamState };

function getToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function emitToolUse(parentToolUseId: string | null, fields: ToolUseFields): StreamChunk {
  if (parentToolUseId === null) {
    return { type: 'tool_use', ...fields };
  }
  return { type: 'subagent_tool_use', subagentId: parentToolUseId, ...fields };
}

function emitToolResult(parentToolUseId: string | null, fields: ToolResultFields): StreamChunk {
  if (parentToolUseId === null) {
    return { type: 'tool_result', ...fields };
  }
  return { type: 'subagent_tool_result', subagentId: parentToolUseId, ...fields };
}

export interface TransformOptions {
  /** The intended model from settings/query (used for context window size). */
  intendedModel?: string;
  /** Custom context limits from settings (model ID → tokens). */
  customContextLimits?: Record<string, number>;
  /** Tracks active streamed tool blocks so input_json_delta can be normalized. */
  streamState?: TransformStreamState;
}

interface MessageUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ContextWindowEntry {
  model: string;
  contextWindow: number;
}

interface ClaudeModelSignature {
  normalizedModel: string;
  family: 'haiku' | 'sonnet' | 'opus';
  is1M: boolean;
  major?: string;
  minor?: string;
  date?: string;
}

function isResultError(message: { type: 'result'; subtype: string }): message is SDKResultError {
  return !!message.subtype && message.subtype !== 'success';
}

function normalizeClaudeModelId(model: string): string {
  const normalized = model.trim().toLowerCase();
  const claudeIndex = normalized.indexOf('claude-');
  return claudeIndex >= 0 ? normalized.slice(claudeIndex) : normalized;
}

function parseClaudeModelSignature(model: string): ClaudeModelSignature | null {
  const normalized = normalizeClaudeModelId(model);
  if (normalized === 'haiku') {
    return { normalizedModel: normalized, family: 'haiku', is1M: false };
  }
  if (normalized === 'sonnet' || normalized === 'sonnet[1m]') {
    return { normalizedModel: normalized, family: 'sonnet', is1M: normalized.endsWith('[1m]') };
  }
  if (normalized === 'opus' || normalized === 'opus[1m]') {
    return { normalizedModel: normalized, family: 'opus', is1M: normalized.endsWith('[1m]') };
  }

  const versionedMatch = normalized.match(
    /^claude-(haiku|sonnet|opus)-(\d+)(?:-(\d+))?(?:-(\d{8}))?(?:-v\d+:\d+)?(\[1m\])?$/,
  );
  if (versionedMatch) {
    const [, familyMatch, major, minor, date, oneMillionSuffix] = versionedMatch;
    const family = familyMatch as ClaudeModelSignature['family'];
    return {
      normalizedModel: normalized,
      family,
      is1M: oneMillionSuffix === '[1m]',
      major,
      minor,
      date,
    };
  }

  return null;
}

function findUniqueEntry(
  entries: ContextWindowEntry[],
  predicate: (entry: ContextWindowEntry) => boolean,
): ContextWindowEntry | null {
  const matches = entries.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}

function matchClaudeModelSignature(
  entrySignature: ClaudeModelSignature | null,
  intendedSignature: ClaudeModelSignature,
  options?: { ignoreIs1M?: boolean },
): boolean {
  if (!entrySignature || entrySignature.family !== intendedSignature.family) {
    return false;
  }
  if (!options?.ignoreIs1M && entrySignature.is1M !== intendedSignature.is1M) {
    return false;
  }
  if (intendedSignature.major && entrySignature.major !== intendedSignature.major) {
    return false;
  }
  if (intendedSignature.minor && entrySignature.minor !== intendedSignature.minor) {
    return false;
  }
  if (intendedSignature.date && entrySignature.date !== intendedSignature.date) {
    return false;
  }
  return true;
}

function selectContextWindowEntry(
  modelUsage: Record<string, { contextWindow?: number }>,
  intendedModel?: string
): ContextWindowEntry | null {
  const entries: ContextWindowEntry[] = Object.entries(modelUsage)
    .flatMap(([model, usage]) =>
      typeof usage?.contextWindow === 'number' && usage.contextWindow > 0
        ? [{ model, contextWindow: usage.contextWindow }]
        : []
    );

  if (entries.length === 0) {
    return null;
  }

  if (entries.length === 1) {
    return entries[0];
  }

  if (!intendedModel) {
    return null;
  }

  const literalExactMatch = entries.find((entry) => entry.model === intendedModel);
  if (literalExactMatch) {
    return literalExactMatch;
  }

  const normalizedIntendedModel = normalizeClaudeModelId(intendedModel);
  const exactMatch = findUniqueEntry(entries, (entry) => normalizeClaudeModelId(entry.model) === normalizedIntendedModel);
  if (exactMatch) {
    return exactMatch;
  }

  if (!isDefaultClaudeModel(intendedModel)) {
    return null;
  }

  const intendedSignature = parseClaudeModelSignature(intendedModel);
  if (!intendedSignature) {
    return null;
  }

  const strictSignatureMatch = findUniqueEntry(entries, (entry) =>
    matchClaudeModelSignature(parseClaudeModelSignature(entry.model), intendedSignature),
  );
  if (strictSignatureMatch) {
    return strictSignatureMatch;
  }

  const hasVersionedTarget = Boolean(intendedSignature.major || intendedSignature.date);
  if (!hasVersionedTarget) {
    return null;
  }

  return findUniqueEntry(entries, (entry) =>
    matchClaudeModelSignature(parseClaudeModelSignature(entry.model), intendedSignature, { ignoreIs1M: true }),
  );
}

/**
 * Transform SDK message to StreamChunk format.
 * One SDK message can yield multiple chunks (e.g., text + tool_use blocks).
 */
export function* transformSDKMessage(
  message: SDKMessage,
  options?: TransformOptions
): Generator<TransformEvent> {
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init' && message.session_id) {
        yield {
          type: 'session_init',
          sessionId: message.session_id,
          agents: message.agents,
          permissionMode: message.permissionMode,
        };
      } else if (message.subtype === 'compact_boundary') {
        yield { type: 'context_compacted' };
      }
      break;

    case 'assistant': {
      const parentToolUseId = message.parent_tool_use_id ?? null;

      // Errors on assistant messages (e.g. rate_limit, billing_error)
      if (message.error) {
        yield { type: 'error', content: message.error };
      }

      if (message.message?.content && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'thinking' && block.thinking) {
            if (parentToolUseId === null) {
              yield { type: 'thinking', content: block.thinking };
            }
          } else if (block.type === 'text' && block.text && block.text.trim() !== '(no content)') {
            if (parentToolUseId === null) {
              yield { type: 'text', content: block.text };
            }
          } else if (block.type === 'tool_use') {
            yield emitToolUse(parentToolUseId, {
              id: block.id || `tool-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
              name: block.name || 'unknown',
              input: getToolInput(block.input),
            });
          }
        }
      }

      options?.streamState?.clearParent(parentToolUseId);

      // Extract usage from main agent assistant messages only (not subagent)
      // This gives accurate per-turn context usage without subagent token pollution
      const usage = (message.message as { usage?: MessageUsage } | undefined)?.usage;
      if (parentToolUseId === null && usage) {
        const inputTokens = usage.input_tokens ?? 0;
        const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
        const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
        const contextTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;

        const model = options?.intendedModel ?? 'sonnet';
        const contextWindow = getContextWindowSize(model, options?.customContextLimits);
        const percentage = Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)));

        const usageInfo: UsageInfo = {
          model,
          inputTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          contextWindow,
          contextTokens,
          percentage,
        };
        yield { type: 'usage', usage: usageInfo };
      }
      break;
    }

    case 'user': {
      const parentToolUseId = message.parent_tool_use_id ?? null;

      // Check for blocked tool calls (from hook denials)
      if (isBlockedMessage(message)) {
        yield {
          type: 'notice',
          content: message._blockReason,
          level: 'warning',
        };
        break;
      }
      // User messages can contain tool results
      if (message.tool_use_result !== undefined && message.parent_tool_use_id) {
        const toolUseResult = (message.tool_use_result ?? undefined) as SDKToolUseResult | undefined;
        yield emitToolResult(parentToolUseId, {
          id: message.parent_tool_use_id,
          content: extractToolResultContent(message.tool_use_result, { fallbackIndent: 2 }),
          isError: false,
          ...(toolUseResult !== undefined ? { toolUseResult } : {}),
        });
      }
      // Also check message.message.content for tool_result blocks
      if (message.message?.content && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'tool_result') {
            const toolUseResult = (message.tool_use_result ?? undefined) as SDKToolUseResult | undefined;
            yield emitToolResult(parentToolUseId, {
              id: block.tool_use_id || message.parent_tool_use_id || '',
              content: extractToolResultContent(block.content, { fallbackIndent: 2 }),
              isError: block.is_error || false,
              ...(toolUseResult !== undefined ? { toolUseResult } : {}),
            });
          }
        }
      }
      break;
    }

    case 'stream_event': {
      const parentToolUseId = message.parent_tool_use_id ?? null;
      const event = message.event;
      if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const toolUseFields: ToolUseFields = {
          id: event.content_block.id || `tool-${Date.now()}`,
          name: event.content_block.name || 'unknown',
          input: getToolInput(event.content_block.input),
        };
        if (typeof event.index === 'number') {
          options?.streamState?.registerToolUse(parentToolUseId, event.index, toolUseFields);
        }
        yield emitToolUse(parentToolUseId, toolUseFields);
      } else if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        if (parentToolUseId === null && event.content_block.thinking) {
          yield { type: 'thinking', content: event.content_block.thinking };
        }
      } else if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
        if (parentToolUseId === null && event.content_block.text) {
          yield { type: 'text', content: event.content_block.text };
        }
      } else if (event?.type === 'content_block_delta') {
        if (event.delta?.type === 'input_json_delta' && typeof event.index === 'number') {
          const toolUseFields = options?.streamState?.applyInputJsonDelta(
            parentToolUseId,
            event.index,
            event.delta.partial_json,
          );
          if (toolUseFields) {
            yield emitToolUse(parentToolUseId, toolUseFields);
          }
        } else if (parentToolUseId === null && event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          yield { type: 'thinking', content: event.delta.thinking };
        } else if (parentToolUseId === null && event.delta?.type === 'text_delta' && event.delta.text) {
          yield { type: 'text', content: event.delta.text };
        }
      } else if (event?.type === 'content_block_stop' && typeof event.index === 'number') {
        options?.streamState?.clearContentBlock(parentToolUseId, event.index);
      }
      break;
    }

    case 'result':
      options?.streamState?.clearAll();
      if (isResultError(message)) {
        const content = message.errors.filter((e) => e.trim().length > 0).join('\n');
        yield {
          type: 'error',
          content: content || `Result error: ${message.subtype}`,
        };
      }

      // Usage is now extracted from assistant messages for accuracy (excludes subagent tokens)
      // Result message usage is aggregated across main + subagents, causing inaccurate spikes

      if ('modelUsage' in message && message.modelUsage) {
        const modelUsage = message.modelUsage as Record<string, { contextWindow?: number }>;
        const selectedEntry = selectContextWindowEntry(modelUsage, options?.intendedModel);
        if (selectedEntry) {
          yield { type: 'context_window', contextWindow: selectedEntry.contextWindow };
        }
      }
      break;

    default:
      break;
  }
}
