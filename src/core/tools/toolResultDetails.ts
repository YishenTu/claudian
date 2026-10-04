import type {
  ScriptToolCallItem,
  ToolCallInfo,
  ToolResultDetails,
  ToolResultImage,
  WebSearchResultItem,
} from '../types/tools';
import { normalizeResolvedAnswers } from './toolInput';

/** Keeps hits with a URL; a missing title falls back to the URL. */
export function normalizeWebSearchResults(items: unknown): WebSearchResultItem[] | undefined {
  if (!Array.isArray(items)) return undefined;
  const results = items.flatMap((item): WebSearchResultItem[] => {
    if (!isRecord(item)) return [];
    const { title, url, snippet, publishedAt } = item;
    if (typeof title !== 'string' || typeof url !== 'string' || !url) return [];
    return [{
      title: title || url,
      url,
      ...(typeof snippet === 'string' && snippet ? { snippet } : {}),
      ...(typeof publishedAt === 'string' && publishedAt ? { publishedAt } : {}),
    }];
  });
  return results.length > 0 ? results : undefined;
}

/** Keeps local image files and inline `image/*` data. */
export function normalizeResultImages(items: unknown): ToolResultImage[] | undefined {
  if (!Array.isArray(items)) return undefined;
  const images = items.flatMap((item): ToolResultImage[] => {
    if (!isRecord(item)) return [];
    const alt = typeof item.alt === 'string' && item.alt ? { alt: item.alt } : {};
    if (item.kind === 'file' && typeof item.path === 'string' && item.path) {
      return [{ kind: 'file', path: item.path, ...alt }];
    }
    if (
      item.kind === 'data' && typeof item.data === 'string' && item.data
      && typeof item.mediaType === 'string' && item.mediaType.startsWith('image/')
    ) {
      return [{ kind: 'data', mediaType: item.mediaType, data: item.data, ...alt }];
    }
    return [];
  });
  return images.length > 0 ? images : undefined;
}

const SCRIPT_TOOL_CALL_STATUSES: ReadonlySet<string> = new Set<ScriptToolCallItem['status']>([
  'running', 'completed', 'error', 'cancelled',
]);

/** Keeps named calls with a known status. */
export function normalizeScriptToolCalls(items: unknown): ScriptToolCallItem[] | undefined {
  if (!Array.isArray(items)) return undefined;
  const calls = items.flatMap((item): ScriptToolCallItem[] => {
    if (!isRecord(item)) return [];
    const { name, input, args, status, durationMs, error } = item;
    if (typeof name !== 'string' || !name || typeof status !== 'string' || !SCRIPT_TOOL_CALL_STATUSES.has(status)) return [];
    return [{
      name,
      status: status as ScriptToolCallItem['status'],
      ...(isRecord(input) ? { input } : {}),
      ...(typeof args === 'string' && args ? { args } : {}),
      ...(typeof durationMs === 'number' && Number.isFinite(durationMs) ? { durationMs } : {}),
      ...(typeof error === 'string' && error ? { error } : {}),
    }];
  });
  return calls.length > 0 ? calls : undefined;
}

/**
 * Finishes a provider's decoded result details: drops empty or malformed fields and returns
 * undefined when nothing remains. Providers call it once at the end of their native mapping.
 */
export function normalizeToolResultDetails(details: ToolResultDetails): ToolResultDetails | undefined {
  const webSearchResults = normalizeWebSearchResults(details.webSearchResults);
  const webSearchSummary = typeof details.webSearchSummary === 'string' && details.webSearchSummary.trim()
    ? details.webSearchSummary
    : undefined;
  const resultImages = normalizeResultImages(details.resultImages);
  const scriptToolCalls = normalizeScriptToolCalls(details.scriptToolCalls);
  const resolvedAnswers = normalizeResolvedAnswers(details.resolvedAnswers);
  const normalized: ToolResultDetails = {
    ...(details.resultFormat === 'plain' ? { resultFormat: 'plain' } : {}),
    ...(details.diff ? { diff: details.diff } : {}),
    ...(webSearchResults ? { webSearchResults } : {}),
    ...(webSearchSummary ? { webSearchSummary } : {}),
    ...(resultImages ? { resultImages } : {}),
    ...(scriptToolCalls ? { scriptToolCalls } : {}),
    ...(resolvedAnswers ? { resolvedAnswers } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Merges two decoded results; fields from `override` win. */
export function mergeToolResultDetails(
  base: ToolResultDetails | undefined,
  override: ToolResultDetails | undefined,
): ToolResultDetails | undefined {
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...override };
}

/**
 * Applies the presentation fields of a tool result. Absent fields keep the tool's earlier values.
 * Diffs and answers depend on the tool and outcome, so callers apply them explicitly.
 */
export function applyToolResultPresentation(toolCall: ToolCallInfo, details: ToolResultDetails | undefined): void {
  toolCall.resultFormat = details?.resultFormat ?? toolCall.resultFormat;
  toolCall.webSearchResults = details?.webSearchResults ?? toolCall.webSearchResults;
  toolCall.webSearchSummary = details?.webSearchSummary ?? toolCall.webSearchSummary;
  toolCall.resultImages = details?.resultImages ?? toolCall.resultImages;
  toolCall.scriptToolCalls = details?.scriptToolCalls ?? toolCall.scriptToolCalls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
