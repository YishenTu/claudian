/**
 * Tool input helpers.
 *
 * Keeps parsing of common tool inputs consistent across services.
 */

import type { AskUserAnswers } from '../types/tools';

/** Reads the `answers` object of a structured question result. */
export function extractResolvedAnswers(result: unknown): AskUserAnswers | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  return normalizeResolvedAnswers((result as Record<string, unknown>).answers);
}

function normalizeAnswerValue(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => (typeof item === 'string' ? item : String(item)))
      .filter(Boolean)
      .filter((item) => item.length > 0);
    if (normalized.length === 0) return undefined;
    return normalized.length === 1 ? normalized[0] : normalized;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if ('answers' in record) return normalizeAnswerValue(record.answers);
    if ('answer' in record) return normalizeAnswerValue(record.answer);
    if ('value' in record) return normalizeAnswerValue(record.value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Normalizes an answers object keyed by question text or id; empty answers are dropped. */
export function normalizeResolvedAnswers(value: unknown): AskUserAnswers | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  const answers: AskUserAnswers = {};
  for (const [question, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeAnswerValue(rawValue);
    if (normalized) {
      answers[question] = normalized;
    }
  }

  return Object.keys(answers).length > 0 ? answers : undefined;
}

function parseAnswersFromJSONObject(resultText: string): AskUserAnswers | undefined {
  const start = resultText.indexOf('{');
  const end = resultText.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;

  try {
    const parsed = JSON.parse(resultText.slice(start, end + 1)) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return normalizeResolvedAnswers(record.answers) ?? normalizeResolvedAnswers(parsed);
    }
    return normalizeResolvedAnswers(parsed);
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
 * Fallback extractor for AskUserQuestion results when the provider reports no structured
 * answers (for example after reload from JSONL history).
 */
export function extractResolvedAnswersFromResultText(result: unknown): AskUserAnswers | undefined {
  if (typeof result !== 'string') return undefined;
  const trimmed = result.trim();
  if (!trimmed) return undefined;

  return parseAnswersFromJSONObject(trimmed) ?? parseAnswersFromQuotedPairs(trimmed);
}
