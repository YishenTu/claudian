import type { ProviderSubagentLifecycleAdapter } from '../../../core/providers/types';
import type { SubagentInfo, ToolCallInfo } from '../../../core/types';
import { extractPiToolTextContent, getPiToolId, getPiToolName } from './piToolNormalization';

/**
 * Peeps (pi-extensions/peeps) runs child Pi sessions. `peeps_spawn` and `peeps_send` start work
 * whose answer arrives later as a `peeps-result` custom message, so each card is session-owned
 * state assembled from tool calls, result notices and, in history, `peeps/run` entries.
 */
const PEEPS_SPAWN = 'peeps_spawn';
const PEEPS_SEND = 'peeps_send';
const PEEPS_INTERRUPT = 'peeps_interrupt';
const PEEPS_CLOSE = 'peeps_close';
const PEEPS_RESULT_TYPE = 'peeps-result';
export const PI_PEEPS_RUN_ENTRY_TYPE = 'peeps/run';
const DEFAULT_DESCRIPTION = 'Peeps subagent';

export interface PiPeepsResult {
  runId: string;
  seq?: number;
  status: string;
  text: string;
}

interface PeepsCall {
  name: string;
  input: Record<string, unknown>;
}

/** One report notice per child; a batched notice joins several, each with its own header. */
export function parsePiPeepsResults(message: Record<string, unknown>): PiPeepsResult[] | null {
  if (message.customType !== PEEPS_RESULT_TYPE) return null;
  const content = getText(message.content);
  const headers = [...content.matchAll(/^\[Peeps automated result — ([^\]\n]+?) — ([^\]\n]+)\]\n?/gm)];
  if (headers.length === 0 || headers[0].index !== 0) return null;
  const items = getDetailItems(message.details);
  return headers.map((header, index) => {
    const end = index + 1 < headers.length ? headers[index + 1].index : content.length;
    const text = content.slice(header.index + header[0].length, end);
    const item = items.find(candidate => candidate.runId === header[1]);
    return {
      runId: header[1],
      status: header[2],
      // Peeps separates batched reports with a blank line.
      text: index + 1 < headers.length ? text.replace(/\n\n$/, '') : text,
      ...(typeof item?.seq === 'number' ? { seq: item.seq } : {}),
    };
  });
}

/** Builds Peeps cards in native order. Cards are keyed by the tool call that started the work. */
export class PiPeepsSubagents {
  readonly #calls = new Map<string, PeepsCall>();
  readonly #cards = new Map<string, SubagentInfo>();
  readonly #labels = new Map<string, string>();
  readonly #appliedReports = new Set<string>();

  get(toolCallId: string): SubagentInfo | undefined {
    return this.#cards.get(toolCallId);
  }

  /** Live RPC events; returns the cards they changed. */
  rpcEvent(event: Record<string, unknown>): SubagentInfo[] {
    if (event.type === 'tool_execution_start') {
      const input = getRecord(event.args) ?? getRecord(event.input) ?? getRecord(event.arguments) ?? {};
      return this.toolStarted(getPiToolId(event), getPiToolName(event), input, Date.now());
    }
    if (event.type === 'tool_execution_end') {
      const result = getRecord(event.result);
      return this.toolEnded(getPiToolId(event), {
        details: result?.details,
        isError: event.isError === true,
        text: extractPiToolTextContent(result ?? event.result),
      });
    }
    const message = getRecord(event.message);
    if (event.type === 'message_end' && message?.role === 'custom') {
      return this.customMessage(message, Date.now());
    }
    return [];
  }

  toolStarted(id: string, name: string, input: Record<string, unknown>, startedAt?: number): SubagentInfo[] {
    if (!isPeepsTool(name) || this.#calls.has(id)) return [];
    this.#calls.set(id, { name, input });
    if (name !== PEEPS_SPAWN && name !== PEEPS_SEND) return [];
    const runId = name === PEEPS_SEND ? getString(input.id) : undefined;
    const card: SubagentInfo = {
      id,
      description: getString(input.label) ?? (runId && this.#labels.get(runId)) ?? DEFAULT_DESCRIPTION,
      prompt: getString(name === PEEPS_SPAWN ? input.task : input.message) ?? '',
      isExpanded: false,
      lifecycleSource: 'session',
      status: 'running',
      toolCalls: [],
      ...(runId ? { agentId: runId } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
    this.#cards.set(id, card);
    return [card];
  }

  toolEnded(id: string, result: { text: string; details?: unknown; isError: boolean }): SubagentInfo[] {
    const call = this.#calls.get(id);
    if (!call) return [];
    if (call.name === PEEPS_INTERRUPT || call.name === PEEPS_CLOSE) {
      if (result.isError) return [];
      // Neither reports back, so work they stop would otherwise stay running.
      const target = getString(call.input.id);
      const message = call.name === PEEPS_INTERRUPT ? 'Interrupted' : 'Closed';
      return this.#finishRunning(card => target === 'all' || card.agentId === target, 'error', message);
    }
    const card = this.#cards.get(id);
    if (!card || card.status !== 'running') return [];
    if (result.isError) {
      return [this.#update(card, { status: 'error', result: result.text })];
    }
    const launched = getRecord(result.details) ?? parseJSONObject(result.text);
    const runId = card.agentId ?? getString(launched?.id);
    if (!runId) return [];
    const label = getString(launched?.label);
    if (label && card.description === DEFAULT_DESCRIPTION) card.description = label;
    this.#labels.set(runId, label ?? card.description);
    return [this.#update(card, { agentId: runId })];
  }

  /** Applies each report once; a report answers all work its child had pending. */
  customMessage(message: Record<string, unknown>, completedAt?: number): SubagentInfo[] {
    const updates: SubagentInfo[] = [];
    for (const report of parsePiPeepsResults(message) ?? []) {
      const key = `${report.runId}#${report.seq ?? report.text}`;
      if (this.#appliedReports.has(key)) continue;
      this.#appliedReports.add(key);
      updates.push(...this.#finishRunning(
        card => card.agentId === report.runId,
        report.status === 'failed' ? 'error' : 'completed',
        report.text,
        completedAt,
      ));
    }
    return updates;
  }

  /** History records run state; a closed or failed child no longer answers its pending work. */
  runEntry(data: unknown): SubagentInfo[] {
    const run = getRecord(getRecord(data)?.run);
    const runId = getString(run?.id);
    if (!run || !runId) return [];
    const label = getString(run.label);
    if (label) this.#labels.set(runId, label);
    if (run.status !== 'closed' && run.status !== 'failed') return [];
    return this.#finishRunning(
      card => card.agentId === runId,
      'error',
      getString(run.error) ?? (run.status === 'closed' ? 'Closed' : 'Failed'),
    );
  }

  #finishRunning(
    matches: (card: SubagentInfo) => boolean,
    status: 'completed' | 'error',
    result: string,
    completedAt?: number,
  ): SubagentInfo[] {
    const updates: SubagentInfo[] = [];
    for (const card of this.#cards.values()) {
      if (card.status !== 'running' || !card.agentId || !matches(card)) continue;
      updates.push(this.#update(card, {
        status, result, ...(completedAt !== undefined ? { completedAt } : {}),
      }));
    }
    return updates;
  }

  #update(card: SubagentInfo, patch: Partial<SubagentInfo>): SubagentInfo {
    const next = { ...card, ...patch };
    this.#cards.set(card.id, next);
    return next;
  }
}

function isPeepsTool(name: string): boolean {
  return name === PEEPS_SPAWN || name === PEEPS_SEND || name === PEEPS_INTERRUPT || name === PEEPS_CLOSE;
}

function launchedRunId(toolCall: ToolCallInfo, raw = toolCall.result): string | undefined {
  if (toolCall.name === PEEPS_SEND) return getString(toolCall.input.id);
  return toolCall.subagent?.agentId ?? getString(parseJSONObject(raw)?.id);
}

export const piPeepsSubagentAdapter: ProviderSubagentLifecycleAdapter = {
  protocol: 'lifecycle',
  isSpawnTool: name => name === PEEPS_SPAWN || name === PEEPS_SEND,
  // Status tools stay ordinary tool cards; their effects reach cards through session updates.
  isWaitTool: () => false,
  isCloseTool: () => false,
  isHiddenTool: () => false,
  isToolCallFullyOwned: () => false,
  resolveSpawnToolIds: () => [],
  buildSubagentInfo(toolCall) {
    if (toolCall.subagent) return toolCall.subagent;
    const runId = launchedRunId(toolCall);
    const failed = toolCall.status === 'error' || toolCall.status === 'blocked';
    return {
      id: toolCall.id,
      description: getString(toolCall.input.label) ?? DEFAULT_DESCRIPTION,
      prompt: getString(toolCall.name === PEEPS_SPAWN ? toolCall.input.task : toolCall.input.message) ?? '',
      isExpanded: false,
      status: failed ? 'error' : 'running',
      toolCalls: [],
      ...(failed && toolCall.result ? { result: toolCall.result } : {}),
      ...(runId ? { agentId: runId } : {}),
    };
  },
  extractSpawnResult(raw, toolCall) {
    const agentId = toolCall ? launchedRunId(toolCall, raw) : getString(parseJSONObject(raw)?.id);
    return agentId ? { agentId } : {};
  },
  extractWaitResult: () => ({ statuses: {}, timedOut: false }),
};

function getDetailItems(details: unknown): Array<{ runId?: unknown; seq?: unknown }> {
  const record = getRecord(details);
  if (!record) return [];
  // Peeps before batched notices put one result's fields directly on details.
  return Array.isArray(record.results) ? record.results.filter(isRecord) : [record];
}

function getText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')
    .join('');
}

function parseJSONObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    return getRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
