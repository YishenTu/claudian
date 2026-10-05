import { setIcon } from 'obsidian';

import type { ScriptToolCallItem, ToolCallInfo } from '@/core/types';
import { contentFallback, getInputText, truncateText } from '@/features/chat/rendering/tools/toolContentPrimitives';
import { stringifyUnknown } from '@/utils/stringify';

/** Header text for a nested tool, supplied by the presentation table. */
export type DescribeTool = (name: string, input: Record<string, unknown>) => { name: string; summary: string };

export type ScriptToolContent = Pick<ToolCallInfo, 'result' | 'input' | 'resultImages' | 'scriptToolCalls'>
  & Partial<Pick<ToolCallInfo, 'status'>>;

const SCRIPT_CALL_STATUS_ICONS: Partial<Record<ScriptToolCallItem['status'], string>> = {
  completed: 'check',
  error: 'x',
  cancelled: 'ban',
};

function getScriptSource(input: Record<string, unknown>): string {
  return [input.code, input.raw, input.value].find((value): value is string => (
    typeof value === 'string' && value.trim().length > 0
  )) ?? '';
}

export function getScriptLanguage(input: Record<string, unknown>): string {
  return getInputText(input, 'language').trim() || 'JavaScript';
}

export function getScriptSummary(input: Record<string, unknown>): string {
  const title = getInputText(input, 'title').trim();
  if (title) return truncateText(title, 60);
  const firstLine = getScriptSource(input).split('\n')
    .map(line => line.trim())
    .find(line => line && !line.startsWith('//'));
  return truncateText(firstLine ?? '', 60);
}

function formatScriptCallDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** `key: value` pairs for tools without a dedicated summary. */
function summarizeToolInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${stringifyUnknown(value)}`)
    .join(', ');
}

function renderScriptToolCalls(container: HTMLElement, calls: ScriptToolCallItem[], describeTool: DescribeTool): void {
  container.createDiv({ cls: 'claudian-tool-script-label', text: 'Tool calls' });
  const listEl = container.createEl('ul', { cls: 'claudian-tool-script-calls', attr: { 'aria-label': 'Tool calls' } });
  for (const call of calls) {
    const itemEl = listEl.createEl('li', { cls: 'claudian-tool-script-call' });
    const statusEl = itemEl.createSpan({
      cls: `claudian-tool-status status-${call.status}`,
      attr: { role: 'img', 'aria-label': `Status: ${call.status}` },
    });
    const icon = SCRIPT_CALL_STATUS_ICONS[call.status];
    if (icon) setIcon(statusEl, icon);
    const described = call.input ? describeTool(call.name, call.input) : undefined;
    const summary = truncateText(
      call.input ? described?.summary || summarizeToolInput(call.input) : call.args ?? '',
      80,
    );
    itemEl.createSpan({ cls: 'claudian-tool-script-call-name', text: described?.name ?? call.name });
    if (summary) {
      itemEl.append(' ');
      itemEl.createSpan({ cls: 'claudian-tool-script-call-detail', text: summary });
    }
    if (call.durationMs !== undefined) {
      itemEl.append(' ');
      itemEl.createSpan({ cls: 'claudian-tool-script-call-detail', text: formatScriptCallDuration(call.durationMs) });
    }
    if (call.error) {
      itemEl.createDiv({ cls: 'claudian-tool-script-call-error', text: call.error });
    }
  }
}

/** Source, nested tool calls and output; an image-only result keeps the output section without a placeholder. */
export function renderScriptContent(
  container: HTMLElement,
  toolCall: ScriptToolContent,
  describeTool: DescribeTool,
): void {
  const source = getScriptSource(toolCall.input);
  if (source) {
    container.createDiv({ cls: 'claudian-tool-script-label', text: getScriptLanguage(toolCall.input) });
    const sourceEl = container.createEl('pre', { cls: 'claudian-tool-script-code' });
    sourceEl.createEl('code', { text: source });
  }
  if (toolCall.scriptToolCalls?.length) {
    renderScriptToolCalls(container, toolCall.scriptToolCalls, describeTool);
  }
  const result = toolCall.result ?? '';
  container.createDiv({ cls: 'claudian-tool-script-label', text: 'Output' });
  if (result) {
    container.createEl('pre', { cls: 'claudian-tool-script-output', text: result });
  } else if (!toolCall.resultImages?.length) {
    contentFallback(container, toolCall.status === 'running' ? 'Running...' : 'No result');
  }
}
