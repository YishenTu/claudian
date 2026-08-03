import type { CitationEntry, CitationGroup } from '../../../core/types';

const MEMORY_CITATION_OPEN = '<oai-mem-citation>';
const MEMORY_CITATION_CLOSE = '</oai-mem-citation>';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readLineNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

function normalizeEntry(value: unknown): CitationEntry | null {
  const entry = asRecord(value);
  if (!entry || typeof entry.path !== 'string' || typeof entry.note !== 'string') {
    return null;
  }

  const path = entry.path.trim();
  const lineStart = readLineNumber(entry.lineStart, entry.line_start);
  const lineEnd = readLineNumber(entry.lineEnd, entry.line_end);
  if (!path || lineStart === null || lineEnd === null || lineEnd < lineStart) {
    return null;
  }

  return {
    path,
    lineStart,
    lineEnd,
    note: entry.note.trim(),
  };
}

export function normalizeCodexMemoryCitation(value: unknown): CitationGroup | null {
  const citation = asRecord(value);
  if (!citation || !Array.isArray(citation.entries)) {
    return null;
  }

  const entries = citation.entries
    .map(normalizeEntry)
    .filter((entry): entry is CitationEntry => entry !== null);
  return entries.length > 0 ? { kind: 'memory', entries } : null;
}

export function stripCodexMemoryCitationMarkup(text: string): string {
  let cursor = 0;
  let visibleText = '';

  while (cursor < text.length) {
    const openIndex = text.indexOf(MEMORY_CITATION_OPEN, cursor);
    if (openIndex < 0) {
      visibleText += text.slice(cursor);
      break;
    }

    visibleText += text.slice(cursor, openIndex);
    const bodyStart = openIndex + MEMORY_CITATION_OPEN.length;
    const closeIndex = text.indexOf(MEMORY_CITATION_CLOSE, bodyStart);
    if (closeIndex < 0) {
      break;
    }
    cursor = closeIndex + MEMORY_CITATION_CLOSE.length;
  }

  return visibleText;
}
