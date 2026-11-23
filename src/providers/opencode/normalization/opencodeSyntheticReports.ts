import { isRecord } from '../http/OpencodeHTTPClient';

/**
 * OpenCode reports finished background work to the session that started it as a synthetic inbox
 * item: `<source attrs…>body</source>` text plus `metadata.source`; 2.4 wraps every source in
 * `<background-result kind="source" attrs…>`. Returns the attributes and body after the tag name.
 */
function unwrapReport(text: string, source: string): string | null {
  const trimmed = text.trim();
  for (const [open, close] of [[`<${source} `, `</${source}>`], [`<background-result kind="${source}" `, '</background-result>']]) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close)) return trimmed.slice(open.length, -close.length);
  }
  return null;
}

/** The opening tag holds the shell command unescaped, so `header` gives the known attribute text. */
function readReportBody(report: string, header?: string): string | null {
  const headerEnd = header !== undefined && report.startsWith(header) ? header.length : report.indexOf('">') + 2;
  if (headerEnd < 2) return null;
  return report.slice(headerEnd).trim();
}

/**
 * The task notification for a native background-shell report: its command and output, which
 * ends with the native exit line. Reports from other sources (subagents) belong to their cards.
 */
export function formatOpencodeShellReport(report: unknown): string | null {
  if (!isRecord(report) || !isRecord(report.metadata) || report.metadata.source !== 'shell' || typeof report.text !== 'string') return null;
  const command = typeof report.description === 'string' ? report.description : '';
  const inner = unwrapReport(report.text, 'shell');
  const header = inner === null ? undefined : /^id="[^"]*" state="[^"]*" command="/u.exec(inner)?.[0];
  const body = inner === null ? null : readReportBody(inner, header && command ? `${header}${command}">` : undefined);
  if (body === null) return null;
  const blocks = [...(command.trim() ? [fence('sh', command.trim())] : []), ...(body ? [fence('text', body)] : [])];
  return blocks.join('\n\n') || null;
}

/** A child's idle report. Its envelope state is authoritative: 2.3 reports `running` while the child's own background work continues. */
export type OpencodeSubagentReportState = 'running' | 'completed' | 'error' | 'cancelled';

export interface OpencodeSubagentReport {
  readonly childId: string;
  readonly state: OpencodeSubagentReportState;
  readonly body: string;
}

const REPORT_STATES: readonly string[] = ['running', 'completed', 'error', 'cancelled'] satisfies OpencodeSubagentReportState[];

export function readOpencodeSubagentReport(report: unknown): OpencodeSubagentReport | null {
  if (!isRecord(report) || !isRecord(report.metadata) || report.metadata.source !== 'subagent' || typeof report.text !== 'string') return null;
  const childId = report.metadata.childID;
  const inner = unwrapReport(report.text, 'subagent');
  const opening = inner === null ? null : /^sessionID="[^"]*" state="([^"]*)" description="/u.exec(inner);
  const description = typeof report.description === 'string' ? report.description : undefined;
  const body = inner === null ? null : readReportBody(inner, opening && description !== undefined ? `${opening[0]}${description}">` : undefined);
  const native = opening?.[1];
  if (typeof childId !== 'string' || !native || body === null) return null;
  // An unknown state is terminal: the child is idle and nothing reports it running.
  const state = REPORT_STATES.includes(native) ? native as OpencodeSubagentReportState : 'error';
  return { childId, state, body };
}

/** A fence longer than any backtick run inside the native text. */
function fence(language: string, content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/gu)].map(match => match[0].length));
  const marks = '`'.repeat(Math.max(3, longest + 1));
  return `${marks}${language}\n${content}\n${marks}`;
}
