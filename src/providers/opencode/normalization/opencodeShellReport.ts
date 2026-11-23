import { isRecord } from '../http/OpencodeHTTPClient';

const SHELL_REPORT = /^\s*<shell\b[^>]*>\n?([\s\S]*?)\n?<\/shell>\s*$/u;

/**
 * The task notification for a native background-shell report: its command and output, which
 * ends with the native exit line. Reports from other sources (subagents) belong to their cards.
 */
export function formatOpencodeShellReport(report: unknown): string | null {
  if (!isRecord(report) || !isRecord(report.metadata) || report.metadata.source !== 'shell') return null;
  const body = typeof report.text === 'string' ? SHELL_REPORT.exec(report.text)?.[1].trim() : undefined;
  if (body === undefined) return null;
  const command = typeof report.description === 'string' ? report.description.trim() : '';
  return [...(command ? [fence('sh', command)] : []), ...(body ? [fence('text', body)] : [])].join('\n\n') || null;
}

/** A fence longer than any backtick run inside the native text. */
function fence(language: string, content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/gu)].map(match => match[0].length));
  const marks = '`'.repeat(Math.max(3, longest + 1));
  return `${marks}${language}\n${content}\n${marks}`;
}
