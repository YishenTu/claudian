/**
 * Tool input helpers.
 *
 * Keeps parsing of common tool inputs consistent across services.
 */

import type { AskUserAnswers } from '../types/tools';
import {
  TOOL_EDIT,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LS,
  TOOL_NOTEBOOK_EDIT,
  TOOL_READ,
  TOOL_WRITE,
} from './toolNames';

export function extractResolvedAnswers(toolUseResult: unknown): AskUserAnswers | undefined {
  if (typeof toolUseResult !== 'object' || toolUseResult === null) return undefined;
  const r = toolUseResult as Record<string, unknown>;
  if (!r.answers || typeof r.answers !== 'object') return undefined;
  return r.answers as AskUserAnswers;
}

function normalizeAnswerValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => (typeof item === 'string' ? item : String(item)))
      .filter(Boolean)
      .join(', ');
    return normalized || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function parseAnswersFromJsonObject(resultText: string): AskUserAnswers | undefined {
  const start = resultText.indexOf('{');
  const end = resultText.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;

  try {
    const parsed = JSON.parse(resultText.slice(start, end + 1)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

    const answers: AskUserAnswers = {};
    for (const [question, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeAnswerValue(value);
      if (normalized) answers[question] = normalized;
    }
    return Object.keys(answers).length > 0 ? answers : undefined;
  } catch {
    return undefined;
  }
}

function parseAnswersFromQuotedPairs(resultText: string): AskUserAnswers | undefined {
  const answers: AskUserAnswers = {};
  const pattern = /"([^"]+)"="([^"]*)"/g;

  for (const match of resultText.matchAll(pattern)) {
    const question = match[1]?.trim();
    if (!question) continue;
    answers[question] = match[2] ?? '';
  }

  return Object.keys(answers).length > 0 ? answers : undefined;
}

/**
 * Fallback extractor for AskUserQuestion results when structured `toolUseResult.answers`
 * is unavailable (for example after reload from JSONL history).
 */
export function extractResolvedAnswersFromResultText(result: unknown): AskUserAnswers | undefined {
  if (typeof result !== 'string') return undefined;
  const trimmed = result.trim();
  if (!trimmed) return undefined;

  return parseAnswersFromJsonObject(trimmed) ?? parseAnswersFromQuotedPairs(trimmed);
}

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
