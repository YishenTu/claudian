import { isRecord } from '../http/OpencodeHTTPClient';

/**
 * OpenCode reports finished background work to the session that started it as a synthetic inbox
 * item: `<source attrs…>body</source>` text plus `metadata.source`. The opening tag holds the shell
 * command unescaped, so a shell header is matched through the command the payload also carries.
 */
function readReportBody(text: string, tag: string, header?: string): string | null {
  const close = `</${tag}>`;
  const trimmed = text.trim();
  if (!trimmed.startsWith(`<${tag} `) || !trimmed.endsWith(close)) return null;
  const headerEnd = header !== undefined && trimmed.startsWith(header) ? header.length : trimmed.indexOf('">') + 2;
  if (headerEnd < 2) return null;
  return trimmed.slice(headerEnd, -close.length).trim();
}

/**
 * The task notification for a native background-shell report: its command and output, which
 * ends with the native exit line. Reports from other sources (subagents) belong to their cards.
 */
export function formatOpencodeShellReport(report: unknown): string | null {
  if (!isRecord(report) || !isRecord(report.metadata) || report.metadata.source !== 'shell' || typeof report.text !== 'string') return null;
  const command = typeof report.description === 'string' ? report.description : '';
  const header = /^<shell id="[^"]*" state="[^"]*" command="/u.exec(report.text.trim())?.[0];
  const body = readReportBody(report.text, 'shell', header && command ? `${header}${command}">` : undefined);
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
  const opening = /^<subagent sessionID="[^"]*" state="([^"]*)" description="/u.exec(report.text.trim());
  const description = typeof report.description === 'string' ? report.description : undefined;
  const body = readReportBody(report.text, 'subagent', opening && description !== undefined ? `${opening[0]}${description}">` : undefined);
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
