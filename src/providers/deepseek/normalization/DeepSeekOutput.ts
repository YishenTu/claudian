import type { ProviderBackgroundOutputEvent, WithoutEventScope } from '@/core/execution/ProviderExecutionEvent';
import * as ToolNames from '@/core/tools/toolNames';
import type { ScriptToolCallItem, ToolResultImage } from '@/core/types';

import { encodeDeepSeekModelId } from '../models';
import { isRecord } from '../remote/DeepSeekRemoteClient';

export type DeepSeekOutputEvent = WithoutEventScope<ProviderBackgroundOutputEvent>;

export class DeepSeekReplayError extends Error {
  constructor() {
    super('DeepSeek output changed during recovery. Reload Claudian or Obsidian, then reopen this conversation to load the native transcript.');
    this.name = 'DeepSeekReplayError';
  }
}

interface Block { kind: 'text' | 'reasoning'; text: string }
interface Attempt {
  id: string;
  nextIndex: number;
  revision: number;
  readonly blocks: Map<number, Block>;
  settled: boolean;
}

/** Append-only rendering of one native turn; admission and event scopes belong to the session. */
export class DeepSeekOutput {
  private readonly attempts = new Map<string, Attempt>();
  private readonly records = new Set<number>();
  private readonly tools = new Set<string>();
  private readonly completedTools = new Set<string>();
  private readonly scriptCalls = new Map<string, Map<string, ScriptToolCallItem>>();
  private current?: Attempt;
  private started = false;
  outputTokens = 0;
  private contextWindow = 0;
  private model?: string;

  constructor(private readonly emit: (event: DeepSeekOutputEvent) => void) {}

  frame(value: unknown): void {
    if (!isRecord(value) || typeof value.attemptId !== 'string' || typeof value.revision !== 'number') throw new Error('Malformed DeepSeek assistant stream.');
    if (value.type === 'start') {
      this.select(value.attemptId, attemptKey(value), value.revision);
      return;
    }
    const attempt = this.current;
    if (!attempt || attempt.id !== value.attemptId) throw replayError();
    if (value.revision <= attempt.revision) return;
    if (typeof value.index !== 'number' || value.index !== attempt.nextIndex) throw replayError();
    attempt.revision = value.revision;
    if (value.type === 'chunk') {
      attempt.nextIndex++;
      this.chunk(attempt, value.chunk);
    } else if (value.type === 'end' && isRecord(value.outcome)) {
      if (value.outcome.kind === 'abandoned' && attempt.blocks.size > 0) throw replayError();
      attempt.settled = true;
    } else throw new Error('Malformed DeepSeek assistant frame.');
  }

  baseline(value: unknown): void {
    if (!isRecord(value)) return;
    const active = value.activeAttempt;
    if (!isRecord(active)) {
      if (this.current && !this.current.settled && this.current.blocks.size > 0) throw replayError();
      return;
    }
    if (typeof active.attemptId !== 'string' || typeof value.revision !== 'number'
      || typeof active.nextIndex !== 'number' || !Array.isArray(active.stream)) throw new Error('Malformed DeepSeek assistant baseline.');
    const attempt = this.select(active.attemptId, attemptKey(active), value.revision);
    const blocks = compactBlocks(active.stream);
    this.reconcileBlocks(attempt, blocks);
    attempt.nextIndex = active.nextIndex;
    attempt.revision = value.revision;
  }

  record(value: unknown): void {
    if (!isRecord(value) || typeof value.seq !== 'number' || typeof value.type !== 'string' || !isRecord(value.data)) {
      throw new Error('Malformed DeepSeek durable event.');
    }
    if (this.records.has(value.seq)) return;
    this.records.add(value.seq);
    if (value.surfaceOp !== undefined && value.surfaceOp !== 'append') return;
    const data = value.data;
    if (value.type === 'request/context') {
      this.contextWindow = typeof data.contextWindow === 'number' && Number.isFinite(data.contextWindow) ? Math.max(0, data.contextWindow) : 0;
      this.model = typeof data.provider === 'string' && typeof data.model === 'string' ? encodeDeepSeekModelId(data.provider, data.model) : undefined;
    } else if (value.type === 'assistant/message' || value.type === 'assistant/attempt') {
      const key = attemptKey(data);
      const attempt = this.attempts.get(key) ?? this.select(`durable:${value.seq}`, key, 0);
      const content = isRecord(data.message) && Array.isArray(data.message.content) ? data.message.content : undefined;
      const blocks = content ? contentBlocks(content) : compactBlocks(Array.isArray(data.stream) ? data.stream : []);
      this.reconcileBlocks(attempt, blocks);
      attempt.settled = true;
      this.usage(data.usage);
    } else if (value.type === 'tool/call') {
      this.toolStart(data.callId, data.name, data.arguments);
    } else if (value.type === 'tool/result' && isRecord(data.message)) {
      this.toolEnd(data.message.toolCallId, data.message.content, data.message.isError);
    } else if (value.type === 'tool/ptc-dispatch-start' || value.type === 'tool/ptc-dispatch') {
      this.scriptDispatch(data, value.type === 'tool/ptc-dispatch');
    } else if (value.type === 'compaction/end' && data.error === undefined) {
      this.emit({ type: 'context_compacted' });
    }
  }

  private select(id: string, key: string, revision: number): Attempt {
    let attempt = this.attempts.get(key);
    if (attempt && attempt.id !== id) {
      if (attempt.blocks.size > 0) throw replayError();
      attempt = undefined;
    }
    if (!attempt) {
      attempt = { id, nextIndex: 0, revision, blocks: new Map(), settled: false };
      this.attempts.set(key, attempt);
    }
    this.current = attempt;
    return attempt;
  }

  private chunk(attempt: Attempt, value: unknown): void {
    if (!isRecord(value)) throw new Error('Malformed DeepSeek assistant chunk.');
    if (value.type === 'text-delta' || value.type === 'reasoning-delta') {
      if (typeof value.index !== 'number' || typeof value.text !== 'string') throw new Error('Malformed DeepSeek text chunk.');
      const kind = value.type === 'text-delta' ? 'text' : 'reasoning';
      const previous = attempt.blocks.get(value.index);
      if (previous && previous.kind !== kind) throw replayError();
      this.block(attempt, value.index, { kind, text: (previous?.text ?? '') + value.text });
    } else if (value.type === 'block-end' && typeof value.index === 'number' && isRecord(value.block)) {
      const block = decodeBlock(value.block);
      if (block) this.block(attempt, value.index, block);
    }
    // Tool arguments are not executable until the durable native tool/call event.
  }

  private reconcileBlocks(attempt: Attempt, blocks: Map<number, Block>): void {
    // Validate the complete prefix before emitting any suffix.
    for (const [index, previous] of attempt.blocks) {
      const next = blocks.get(index);
      if (!next || previous.kind !== next.kind || !next.text.startsWith(previous.text)) throw replayError();
    }
    for (const [index, block] of blocks) this.block(attempt, index, block);
  }

  private block(attempt: Attempt, index: number, block: Block): void {
    const previous = attempt.blocks.get(index);
    if (previous && (previous.kind !== block.kind || !block.text.startsWith(previous.text))) throw replayError();
    const suffix = block.text.slice(previous?.text.length ?? 0);
    attempt.blocks.set(index, block);
    if (!suffix) return;
    this.begin();
    this.emit({ type: block.kind === 'text' ? 'text_delta' : 'thinking_delta', text: suffix });
  }

  private begin(): void {
    if (this.started) return;
    this.started = true; this.emit({ type: 'assistant_message_started' });
  }

  private toolStart(id: unknown, name: unknown, args: unknown, parent?: unknown): void {
    if (typeof id !== 'string' || typeof name !== 'string') throw new Error('Malformed DeepSeek tool call.');
    if (this.tools.has(id)) return;
    this.tools.add(id); this.begin();
    const input = toolInput(name, args);
    this.emit({ type: 'tool_started', toolCallId: id, name: TOOL_NAMES[name] ?? name, input,
      toolScope: { kind: 'main' }, ...(typeof parent === 'string' ? { parentToolCallId: parent } : {}),
      providerPayload: { rawName: name },
    });
  }

  private toolEnd(id: unknown, content: unknown, isError: unknown, parent?: unknown): void {
    if (typeof id !== 'string') throw new Error('Malformed DeepSeek tool result.');
    if (this.completedTools.has(id)) return;
    this.completedTools.add(id);
    const calls = this.scriptCalls.get(id);
    const resultImages: ToolResultImage[] = Array.isArray(content) ? content.filter(isRecord)
      .filter(block => block.type === 'image' && typeof block.data === 'string' && typeof block.mediaType === 'string')
      .map(block => ({ kind: 'data', mediaType: block.mediaType as string, data: block.data as string, alt: typeof block.name === 'string' ? block.name : undefined })) : [];
    this.emit({ type: 'tool_completed', toolCallId: id, content: deepseekText(content), isError: isError === true,
      toolScope: { kind: 'main' }, ...(typeof parent === 'string' ? { parentToolCallId: parent } : {}),
      resultDetails: { resultFormat: 'plain', ...(resultImages.length ? { resultImages } : {}), ...(calls ? { scriptToolCalls: [...calls.values()] } : {}) },
    });
  }

  private scriptDispatch(data: Record<string, unknown>, completed: boolean): void {
    if (typeof data.rootCallId !== 'string' || typeof data.subCallId !== 'string' || typeof data.name !== 'string') throw new Error('Malformed DeepSeek code-mode dispatch.');
    // Spawn calls need ordinary tool identities so existing child cards can receive lifecycle updates.
    if (data.name === 'subagent' || data.name === 'subagent_fork') {
      this.toolStart(data.subCallId, data.name, data.arguments, data.rootCallId);
      if (completed) this.toolEnd(data.subCallId, data.content, data.isError, data.rootCallId);
      return;
    }
    const calls = this.scriptCalls.get(data.rootCallId) ?? new Map<string, ScriptToolCallItem>();
    const previous = calls.get(data.subCallId);
    if (previous && previous.status !== 'running' && !completed) return;
    calls.set(data.subCallId, { name: TOOL_NAMES[data.name] ?? data.name, input: toolInput(data.name, data.arguments),
      status: completed ? data.isError === true ? 'error' : 'completed' : 'running',
      ...(completed && data.isError === true ? { error: deepseekText(data.content) } : {}),
    });
    this.scriptCalls.set(data.rootCallId, calls);
    this.emit({ type: 'tool_output', toolCallId: data.rootCallId, toolScope: { kind: 'main' }, content: '', resultDetails: { scriptToolCalls: [...calls.values()] } });
  }

  private usage(value: unknown): void {
    if (!isRecord(value)) return;
    const number = (key: string): number => typeof value[key] === 'number' && Number.isFinite(value[key]) ? Math.max(0, value[key]) : 0;
    const inputTokens = number('inputTokens');
    const cacheReadInputTokens = number('cacheReadTokens');
    const cacheCreationInputTokens = number('cacheWriteTokens');
    this.outputTokens += number('outputTokens');
    const contextTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
    this.emit({ type: 'usage_updated', usage: { model: this.model, inputTokens, cacheReadInputTokens, cacheCreationInputTokens,
      contextTokens, contextWindow: this.contextWindow, percentage: this.contextWindow > 0 ? contextTokens / this.contextWindow * 100 : 0,
    } });
  }
}

export function deepseekText(content: unknown): string {
  return Array.isArray(content) ? content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n') : '';
}

function attemptKey(value: Record<string, unknown>): string {
  if (typeof value.turn !== 'number' || typeof value.step !== 'number') throw new Error('Malformed DeepSeek attempt identity.');
  return `${value.turn}:${value.step}`;
}
function replayError(): Error {
  return new DeepSeekReplayError();
}

function decodeBlock(value: Record<string, unknown>): Block | undefined {
  return (value.type === 'text' || value.type === 'reasoning') && typeof value.text === 'string'
    ? { kind: value.type, text: value.text } : undefined;
}

function contentBlocks(content: unknown[]): Map<number, Block> {
  const blocks = new Map<number, Block>();
  content.forEach((value, index) => { if (isRecord(value)) { const block = decodeBlock(value); if (block) blocks.set(index, block); } });
  return blocks;
}

function compactBlocks(stream: unknown[]): Map<number, Block> {
  const blocks = new Map<number, Block>();
  for (const record of stream) {
    if (!isRecord(record)) throw new Error('Malformed DeepSeek compact stream.');
    if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
      if (typeof record.index !== 'number' || !Array.isArray(record.texts) || !record.texts.every(text => typeof text === 'string')) throw new Error('Malformed DeepSeek compact text.');
      const kind = record.type === 'text-chunks' ? 'text' : 'reasoning';
      const previous = blocks.get(record.index);
      if (previous && previous.kind !== kind) throw replayError();
      blocks.set(record.index, { kind, text: (previous?.text ?? '') + record.texts.join('') });
    } else if (record.type === 'chunk' && isRecord(record.chunk) && record.chunk.type === 'block-end'
      && typeof record.chunk.index === 'number' && isRecord(record.chunk.block)) {
      const block = decodeBlock(record.chunk.block);
      if (block) blocks.set(record.chunk.index, block);
    }
  }
  return blocks;
}

function toolInput(name: string, value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { parsed = { arguments: value }; } }
  const input = isRecord(parsed) ? { ...parsed } : {};
  if (['read', 'read_image', 'write', 'edit'].includes(name) && typeof input.path === 'string') {
    input.file_path = input.path; delete input.path;
  }
  return input;
}

const TOOL_NAMES: Readonly<Record<string, string>> = {
  read: ToolNames.TOOL_READ, read_image: ToolNames.TOOL_READ, write: ToolNames.TOOL_WRITE, edit: ToolNames.TOOL_EDIT,
  glob: ToolNames.TOOL_GLOB, grep: ToolNames.TOOL_GREP, bash: ToolNames.TOOL_BASH, run_code: ToolNames.TOOL_EXEC,
  job_output: ToolNames.TOOL_BASH_OUTPUT, job_kill: ToolNames.TOOL_KILL_SHELL, skill: ToolNames.TOOL_SKILL,
  ask_user_question: ToolNames.TOOL_ASK_USER_QUESTION, web_search: ToolNames.TOOL_WEB_SEARCH, web_fetch: ToolNames.TOOL_WEB_FETCH,
  subagent: ToolNames.TOOL_SPAWN_AGENT, subagent_fork: ToolNames.TOOL_SPAWN_AGENT,
};
