import type {
  ModelUsage,
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { extractToolResultContent } from '../../../core/tools/toolResultContent';
import type { SDKToolUseResult, UsageInfo } from '../../../core/types';
import {
  CLAUDE_MODEL_TIER_PATTERN,
  type ClaudeModelTier,
  getClaudeModelTierDefinition,
  isClaudeModelTier,
} from '../modelTiers';
import { extractClaudeTextContent, isClaudeNoContentPlaceholder } from '../normalization/claudeTextContent';
import type {
  ClaudeAsyncSubagentCompletionEvent,
  ClaudeStreamChunk,
  ClaudeSubagentProgressEvent,
  TransformEvent,
} from '../sdk/types';
import {
  createTransformStreamState,
  normalizeToolInput,
  type ToolUseFields,
  type TransformStreamState,
} from './toolInputStreamState';

type ToolResultFields = {
  id: string;
  content: string;
  isError?: boolean;
  isBlocked?: boolean;
  toolUseResult?: SDKToolUseResult;
};

export { createTransformStreamState };

function emitToolUse(parentToolUseId: string | null, fields: ToolUseFields): ClaudeStreamChunk {
  if (parentToolUseId === null) {
    return { type: 'tool_use', ...fields };
  }
  return { type: 'subagent_tool_use', subagentId: parentToolUseId, ...fields };
}

function emitToolResult(parentToolUseId: string | null, fields: ToolResultFields): ClaudeStreamChunk {
  if (parentToolUseId === null) {
    return { type: 'tool_result', ...fields };
  }
  return { type: 'subagent_tool_result', subagentId: parentToolUseId, ...fields };
}

function transformTaskNotification(message: SDKTaskNotificationMessage): ClaudeAsyncSubagentCompletionEvent {
  // The UI has no distinct "stopped" state: failed and stopped tasks both settle as errors.
  const status = message.status === 'completed' ? 'completed' : 'error';
  const summary = message.summary.trim();
  return {
    type: 'async_subagent_completion',
    providerSessionId: message.session_id,
    taskId: message.task_id,
    status,
    result: summary || (status === 'completed' ? 'Background task completed.' : 'Background task failed.'),
    ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
  };
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

/** Progress is keyed to the spawning tool call; tasks without one have no card to update. */
function transformTaskProgress(message: SDKTaskProgressMessage): ClaudeSubagentProgressEvent | null {
  const toolCallId = nonEmptyString(message.tool_use_id);
  if (!toolCallId) return null;

  const summary = nonEmptyString(message.summary);
  const lastToolName = nonEmptyString(message.last_tool_name);
  return {
    type: 'subagent_progress',
    progress: {
      toolCallId,
      ...(summary ? { summary } : {}),
      ...(lastToolName ? { lastToolName } : {}),
      toolUses: message.usage.tool_uses,
      totalTokens: message.usage.total_tokens,
      durationMs: message.usage.duration_ms,
    },
  };
}

/** The CLI marks every API-error assistant message it synthesizes with this model id. */
const SYNTHETIC_MODEL = '<synthetic>';

const ASSISTANT_ERROR_MESSAGES: Record<SDKAssistantMessageError, string> = {
  authentication_failed: 'Claude authentication failed. Sign in again or check your API key.',
  oauth_org_not_allowed: 'This organization is not allowed to use Claude with the current sign-in.',
  account_on_hold: 'Your Claude account is on hold.',
  verification_required: 'Claude requires account verification before continuing.',
  billing_error: 'Claude reported a billing error. Check your plan or credits.',
  rate_limit: 'Claude rate limit reached. Try again later.',
  overloaded: 'Claude is overloaded. Try again shortly.',
  invalid_request: 'Claude rejected the request as invalid.',
  model_not_found: 'The selected Claude model was not found.',
  server_error: 'Claude API server error.',
  unknown: 'Claude API request failed.',
  max_output_tokens: 'Claude reached the output token limit for this response.',
  cloud_credential_error: 'Cloud provider credentials for Claude are missing or invalid.',
};

function describeAssistantError(error: SDKAssistantMessageError): string {
  // Unknown codes from a newer CLI stay visible rather than vanishing.
  return ASSISTANT_ERROR_MESSAGES[error] ?? error;
}

/**
 * API failures arrive as a synthetic assistant message whose text is the CLI's error prose (for
 * example a usage-limit reset time). That text is error copy, not a reply. Errors on real model
 * messages (such as `max_output_tokens` after partial output) keep their prose as a reply.
 */
function isSyntheticErrorCarrier(message: SDKAssistantMessage): boolean {
  return message.error !== undefined && message.message.model === SYNTHETIC_MODEL;
}

export interface TransformOptions {
  /** The intended model from settings/query (used to match reported context windows). */
  intendedModel?: string;
  /** Context window reported by the active provider runtime for the intended model. */
  reportedContextWindow?: number;
  /** Tracks active streamed tool blocks so input_json_delta can be normalized. */
  streamState: TransformStreamState;
  /** Tracks prompt-token usage across Anthropic-compatible stream events. */
  usageState: TransformUsageState;
}

type PromptUsageField = 'input_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens';
type StreamDeltaUsage = Extract<SDKPartialAssistantMessage['event'], { type: 'message_delta' }>['usage'];
/** Assistant/message_start usage and message_delta usage differ only in field nullability. */
export type PromptUsageSource =
  | Pick<SDKAssistantMessage['message']['usage'], PromptUsageField>
  | Pick<StreamDeltaUsage, PromptUsageField>;

interface PromptUsageSnapshot {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  contextTokens: number;
}

export interface TransformUsageState {
  clear(): void;
  mergePromptUsage(usage: PromptUsageSource): PromptUsageSnapshot;
  getPromptUsage(): PromptUsageSnapshot;
  hasEmitted(promptUsage: PromptUsageSnapshot): boolean;
  markEmitted(promptUsage: PromptUsageSnapshot): void;
}

interface ContextWindowEntry {
  model: string;
  canonicalModel?: string;
  contextWindow: number;
}

interface ClaudeModelSignature {
  normalizedModel: string;
  family: ClaudeModelTier;
  is1M: boolean;
  major?: string;
  minor?: string;
  date?: string;
}

function normalizeClaudeModelId(model: string): string {
  const normalized = model.trim().toLowerCase();
  const claudeIndex = normalized.indexOf('claude-');
  return claudeIndex >= 0 ? normalized.slice(claudeIndex) : normalized;
}

function parseClaudeModelSignature(model: string): ClaudeModelSignature | null {
  const normalized = normalizeClaudeModelId(model);
  const aliasMatch = normalized.match(/^(\w+?)(\[1m\])?$/);
  if (aliasMatch && isClaudeModelTier(aliasMatch[1])) {
    const family = aliasMatch[1];
    const hasOneMillionSuffix = aliasMatch[2] !== undefined;
    if (hasOneMillionSuffix && !getClaudeModelTierDefinition(family).supportsOneMillionSuffix) {
      return null;
    }
    return { normalizedModel: normalized, family, is1M: hasOneMillionSuffix };
  }

  const versionedMatch = normalized.match(new RegExp(
    `^claude-(${CLAUDE_MODEL_TIER_PATTERN})-(\\d+)(?:-(\\d+))?`
    + '(?:-(\\d{8}))?(?:-v\\d+:\\d+)?(\\[1m\\])?$',
  ));
  if (versionedMatch) {
    const [, familyMatch, major, minor, date, oneMillionSuffix] = versionedMatch;
    const family = familyMatch as ClaudeModelTier;
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
): boolean {
  if (!entrySignature || entrySignature.family !== intendedSignature.family) {
    return false;
  }
  if (entrySignature.is1M !== intendedSignature.is1M) {
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
  modelUsage: Record<string, ModelUsage>,
  intendedModel?: string
): ContextWindowEntry | null {
  const entries: ContextWindowEntry[] = Object.entries(modelUsage)
    .flatMap(([model, usage]) =>
      usage.contextWindow > 0
        ? [{ model, canonicalModel: usage.canonicalModel, contextWindow: usage.contextWindow }]
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

  // The SDK resolves provider-specific keys (inference profiles, gateway ids) to a canonical id.
  const canonicalMatch = findUniqueEntry(entries, (entry) =>
    entry.canonicalModel !== undefined && normalizeClaudeModelId(entry.canonicalModel) === normalizedIntendedModel,
  );
  if (canonicalMatch) {
    return canonicalMatch;
  }

  const intendedSignature = parseClaudeModelSignature(intendedModel);
  // Native tier IDs can include [1m]; explicit model IDs must match the report above.
  if (!intendedSignature || intendedSignature.major) {
    return null;
  }

  return findUniqueEntry(entries, (entry) =>
    matchClaudeModelSignature(parseClaudeModelSignature(entry.model), intendedSignature),
  );
}

const EMPTY_PROMPT_USAGE: PromptUsageSnapshot = {
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  contextTokens: 0,
};

function normalizeTokenCount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function hasPromptUsageField(usage: PromptUsageSource): boolean {
  return usage.input_tokens != null
    || usage.cache_creation_input_tokens != null
    || usage.cache_read_input_tokens != null;
}

function toPromptUsageSnapshot(usage: PromptUsageSource): PromptUsageSnapshot {
  const inputTokens = normalizeTokenCount(usage.input_tokens);
  const cacheCreationInputTokens = normalizeTokenCount(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = normalizeTokenCount(usage.cache_read_input_tokens);
  return {
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    contextTokens: inputTokens + cacheCreationInputTokens + cacheReadInputTokens,
  };
}

function mergePromptUsage(
  current: PromptUsageSnapshot,
  usage: PromptUsageSource,
): PromptUsageSnapshot {
  const next = toPromptUsageSnapshot(usage);
  const inputTokens = Math.max(current.inputTokens, next.inputTokens);
  const cacheCreationInputTokens = Math.max(current.cacheCreationInputTokens, next.cacheCreationInputTokens);
  const cacheReadInputTokens = Math.max(current.cacheReadInputTokens, next.cacheReadInputTokens);
  return {
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    contextTokens: inputTokens + cacheCreationInputTokens + cacheReadInputTokens,
  };
}

function samePromptUsage(a: PromptUsageSnapshot, b: PromptUsageSnapshot): boolean {
  return a.inputTokens === b.inputTokens
    && a.cacheCreationInputTokens === b.cacheCreationInputTokens
    && a.cacheReadInputTokens === b.cacheReadInputTokens
    && a.contextTokens === b.contextTokens;
}

function buildUsageInfo(promptUsage: PromptUsageSnapshot, options: TransformOptions): UsageInfo {
  const model = options.intendedModel ?? 'sonnet';
  return withReportedContextWindow({
    model,
    inputTokens: promptUsage.inputTokens,
    cacheCreationInputTokens: promptUsage.cacheCreationInputTokens,
    cacheReadInputTokens: promptUsage.cacheReadInputTokens,
    contextWindow: 0,
    contextTokens: promptUsage.contextTokens,
    percentage: 0,
  }, options.reportedContextWindow);
}

/** Raw usage carries only a valid reported window; anything else becomes 0 (unknown). */
export function withReportedContextWindow(
  usage: UsageInfo,
  reportedContextWindow?: number,
): UsageInfo {
  const contextWindow = typeof reportedContextWindow === 'number'
    && Number.isFinite(reportedContextWindow)
    && reportedContextWindow > 0
    ? reportedContextWindow
    : 0;
  return {
    ...usage,
    contextWindow,
    percentage: contextWindow > 0
      ? Math.min(100, Math.max(0, Math.round((usage.contextTokens / contextWindow) * 100)))
      : 0,
  };
}

export function createTransformUsageState(): TransformUsageState {
  let promptUsage: PromptUsageSnapshot = { ...EMPTY_PROMPT_USAGE };
  let lastEmittedPromptUsage: PromptUsageSnapshot | null = null;

  return {
    clear(): void {
      promptUsage = { ...EMPTY_PROMPT_USAGE };
      lastEmittedPromptUsage = null;
    },

    mergePromptUsage(usage: PromptUsageSource): PromptUsageSnapshot {
      promptUsage = mergePromptUsage(promptUsage, usage);
      return promptUsage;
    },

    getPromptUsage(): PromptUsageSnapshot {
      return { ...promptUsage };
    },

    hasEmitted(nextPromptUsage: PromptUsageSnapshot): boolean {
      return lastEmittedPromptUsage !== null && samePromptUsage(lastEmittedPromptUsage, nextPromptUsage);
    },

    markEmitted(nextPromptUsage: PromptUsageSnapshot): void {
      lastEmittedPromptUsage = { ...nextPromptUsage };
    },
  };
}

function maybeEmitUsageFromPromptUsage(
  promptUsage: PromptUsageSnapshot,
  options: TransformOptions,
  behavior: { emitZeroUsage?: boolean } = {},
): ClaudeStreamChunk | null {
  if (promptUsage.contextTokens <= 0) {
    return behavior.emitZeroUsage
      ? { type: 'usage', usage: buildUsageInfo(promptUsage, options) }
      : null;
  }

  if (options.usageState.hasEmitted(promptUsage)) {
    return null;
  }

  options.usageState.markEmitted(promptUsage);
  return { type: 'usage', usage: buildUsageInfo(promptUsage, options) };
}

function* transformAssistantMessage(
  message: SDKAssistantMessage,
  options: TransformOptions,
): Generator<ClaudeStreamChunk> {
  const parentToolUseId = message.parent_tool_use_id ?? null;
  // Scripted and replayed frames may omit content; treat that as an empty message.
  const content = message.message.content ?? [];
  const errorCarrier = isSyntheticErrorCarrier(message);

  if (message.error !== undefined) {
    const prose = errorCarrier ? extractClaudeTextContent(content).trim() : '';
    yield { type: 'error', content: prose || describeAssistantError(message.error) };
  }

  for (const block of content) {
    if (block.type === 'thinking' && block.thinking) {
      if (parentToolUseId === null) {
        yield { type: 'thinking', content: block.thinking };
      }
    } else if (block.type === 'text' && block.text && !isClaudeNoContentPlaceholder(block.text)) {
      // A synthetic error's text was already surfaced as the error itself.
      if (parentToolUseId === null && !errorCarrier) {
        yield { type: 'text', content: block.text };
      }
    } else if (block.type === 'tool_use') {
      yield emitToolUse(parentToolUseId, {
        id: block.id,
        name: block.name,
        input: normalizeToolInput(block.input),
      });
    }
  }

  options.streamState.clearParent(parentToolUseId);

  // Main-agent assistant usage gives per-turn context usage without subagent token pollution.
  const usage = message.message.usage;
  if (parentToolUseId === null && usage) {
    const promptUsage = options.usageState.mergePromptUsage(usage);
    const usageChunk = maybeEmitUsageFromPromptUsage(promptUsage, options, { emitZeroUsage: true });
    if (usageChunk) {
      yield usageChunk;
    }
  }
}

function* transformStreamEvent(
  message: SDKPartialAssistantMessage,
  options: TransformOptions,
): Generator<ClaudeStreamChunk> {
  const parentToolUseId = message.parent_tool_use_id ?? null;
  const event = message.event;
  if (!event) return;
  if (event.type === 'message_start') {
    if (parentToolUseId !== null) return;
    options.usageState.clear();
    const usage = event.message.usage;
    if (usage && hasPromptUsageField(usage)) {
      options.usageState.mergePromptUsage(usage);
    }
  } else if (event.type === 'message_delta') {
    if (parentToolUseId !== null || !hasPromptUsageField(event.usage)) return;
    const previousPromptUsage = options.usageState.getPromptUsage();
    const promptUsage = options.usageState.mergePromptUsage(event.usage);
    const shouldEmitDeltaUsage = previousPromptUsage.contextTokens <= 0
      || options.usageState.hasEmitted(previousPromptUsage);
    if (shouldEmitDeltaUsage) {
      const usageChunk = maybeEmitUsageFromPromptUsage(promptUsage, options);
      if (usageChunk) {
        yield usageChunk;
      }
    }
  } else if (event.type === 'content_block_start') {
    const block = event.content_block;
    if (block.type === 'tool_use') {
      const toolUseFields: ToolUseFields = {
        id: block.id,
        name: block.name,
        input: normalizeToolInput(block.input),
      };
      options.streamState.registerToolUse(parentToolUseId, event.index, toolUseFields);
      yield emitToolUse(parentToolUseId, toolUseFields);
    } else if (block.type === 'thinking') {
      if (parentToolUseId === null && block.thinking) {
        yield { type: 'thinking', content: block.thinking };
      }
    } else if (block.type === 'text') {
      if (parentToolUseId === null && block.text) {
        yield { type: 'text', content: block.text };
      }
    }
  } else if (event.type === 'content_block_delta') {
    const delta = event.delta;
    if (delta.type === 'input_json_delta') {
      const toolUseFields = options.streamState.applyInputJsonDelta(
        parentToolUseId,
        event.index,
        delta.partial_json,
      );
      if (toolUseFields) {
        yield emitToolUse(parentToolUseId, toolUseFields);
      }
    } else if (parentToolUseId === null && delta.type === 'thinking_delta' && delta.thinking) {
      yield { type: 'thinking', content: delta.thinking };
    } else if (parentToolUseId === null && delta.type === 'text_delta' && delta.text) {
      yield { type: 'text', content: delta.text };
    }
  } else if (event.type === 'content_block_stop') {
    options.streamState.clearContentBlock(parentToolUseId, event.index);
  }
}

/**
 * Transform an SDK message into Claude stream chunks and provider-specific events.
 * One SDK message can yield multiple events (e.g., text + tool_use blocks).
 */
export function* transformSDKMessage(
  message: SDKMessage,
  options: TransformOptions,
): Generator<TransformEvent> {
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init') {
        yield {
          type: 'session_init',
          sessionId: message.session_id,
          permissionMode: message.permissionMode,
        };
      } else if (message.subtype === 'compact_boundary') {
        yield { type: 'context_compacted' };
      } else if (message.subtype === 'task_notification') {
        yield transformTaskNotification(message);
      } else if (message.subtype === 'task_progress') {
        const progress = transformTaskProgress(message);
        if (progress) {
          yield progress;
        }
      } else if (message.subtype === 'permission_denied') {
        yield emitToolResult(message.agent_id ?? null, {
          id: message.tool_use_id,
          content: message.message,
          isError: true,
          isBlocked: true,
        });
      }
      break;

    case 'assistant':
      yield* transformAssistantMessage(message, options);
      break;

    case 'user': {
      const parentToolUseId = message.parent_tool_use_id ?? null;
      const content = message.message.content;
      const toolResultBlocks = Array.isArray(content)
        ? content.filter(block => block.type === 'tool_result')
        : [];
      const toolUseResult = (message.tool_use_result ?? undefined) as SDKToolUseResult | undefined;
      // A subagent frame's structured output belongs to its own tool_result block; only a frame
      // without one reports that output against the spawning tool call.
      if (toolResultBlocks.length === 0 && message.tool_use_result !== undefined && parentToolUseId) {
        yield emitToolResult(parentToolUseId, {
          id: parentToolUseId,
          content: extractToolResultContent(message.tool_use_result, { fallbackIndent: 2 }),
          isError: false,
          ...(toolUseResult !== undefined ? { toolUseResult } : {}),
        });
      }
      for (const block of toolResultBlocks) {
        yield emitToolResult(parentToolUseId, {
          id: block.tool_use_id,
          content: extractToolResultContent(block.content, { fallbackIndent: 2 }),
          isError: block.is_error || false,
          ...(toolUseResult !== undefined ? { toolUseResult } : {}),
        });
      }
      break;
    }

    case 'stream_event':
      yield* transformStreamEvent(message, options);
      break;

    case 'result':
      options.streamState.clearAll();
      {
        const usageChunk = maybeEmitUsageFromPromptUsage(options.usageState.getPromptUsage(), options);
        if (usageChunk) {
          yield usageChunk;
        }
      }
      options.usageState.clear();
      // Result usage aggregates main + subagent tokens, so context usage comes from assistant
      // messages; the result contributes only the model's reported context window.
      if (message.modelUsage) {
        const selectedEntry = selectContextWindowEntry(message.modelUsage, options.intendedModel);
        if (selectedEntry) {
          yield { type: 'context_window', contextWindow: selectedEntry.contextWindow };
        }
      }
      if (message.subtype !== 'success') {
        const content = message.errors.filter((e) => e.trim().length > 0).join('\n');
        yield {
          type: 'error',
          content: content || `Result error: ${message.subtype}`,
        };
      }
      break;

    default:
      break;
  }
}
