import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeImageMediaType } from '@/core/execution/imageAttachment';
import { resolveToolDiffData } from '@/core/tools/toolDiff';
import { isWriteEditTool } from '@/core/tools/toolNames';
import type { AskUserAnswers, ChatMessage, ContentBlock, ImageAttachment, ToolCallInfo } from '@/core/types';
import { readFileRevision } from '@/utils/fileRevision';
import { forEachJSONLLine } from '@/utils/jsonlFile';

import {
  buildAntigravityToolProviderPayload,
  normalizeAntigravityToolInput,
  normalizeAntigravityToolName,
  normalizeAntigravityToolResult,
} from '../normalization/antigravityToolNormalization';
import { resolveAntigravityTranscriptPaths } from './AntigravityHistoryPaths';

interface TranscriptStep {
  content?: string;
  created_at?: string;
  error?: string;
  media?: Array<{ mime_type?: string; uri?: string }>;
  source?: string;
  status?: string;
  step_index?: number;
  thinking?: string;
  tool_calls?: Array<{ args?: Record<string, unknown>; name?: string }>;
  type?: string;
}

interface PendingTool {
  readonly call: ToolCallInfo;
  readonly rawInput: Record<string, unknown>;
  readonly rawName: string;
}

interface TurnBuilder {
  readonly assistant: ChatMessage;
  readonly blocks: ContentBlock[];
  readonly pending: PendingTool[];
  readonly toolCalls: ToolCallInfo[];
  /** Request time of a user turn; automatic responses have none. */
  readonly requestedAt?: number;
  lastStepAt?: number;
}

/** agy records no result step for calls a denial aborted; a later step proves they never ran. */
const ABORTED_TOOL_RESULT = 'Antigravity did not run this tool.';

const USER_REQUEST_PATTERN = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/;
const RESULT_HEADER_PATTERN = /^(?:(?:Created|Completed) At: [^\n]*\n)+/;
/** A message agy injects into the conversation; `sender=system` marks its own notices, others are task reports. */
const SYSTEM_REPORT_PATTERN = /<SYSTEM_MESSAGE>\n\[Message\][^\n]*?\bsender=(\S+)[^\n]*?\bcontent=([\s\S]*?)\n?<\/SYSTEM_MESSAGE>/;
/** agy appends instructions for the model to a command it moved to the background. */
const BACKGROUND_INSTRUCTIONS_PATTERN = /\s*YOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS:[\s\S]*$/;
const QUESTION_ANSWER_PATTERN = /^A(\d+): (.*)$/;

/** Reads the first existing transcript; a missing or unreadable store yields no messages. */
export async function loadAntigravityHistory(storeRoot: string, sessionId: string): Promise<ChatMessage[]> {
  for (const [index, transcriptPath] of resolveAntigravityTranscriptPaths(storeRoot, sessionId).entries()) {
    try {
      await fs.access(transcriptPath);
    } catch {
      continue;
    }
    const steps: TranscriptStep[] = [];
    await forEachJSONLLine(transcriptPath, line => {
      try {
        const step: unknown = JSON.parse(line);
        if (step && typeof step === 'object' && !Array.isArray(step)) steps.push(step);
      } catch {
        // A partially written last line is skipped; the next read sees it complete.
      }
    });
    // Only the short transcript string-encodes tool arguments.
    const messages = parseAntigravityTranscript(steps, sessionId, index > 0);
    await attachUploadedImages(messages, steps, storeRoot, sessionId);
    return messages;
  }
  return [];
}

export async function readAntigravityHistoryRevision(storeRoot: string, sessionId: string): Promise<string | null> {
  for (const transcriptPath of resolveAntigravityTranscriptPaths(storeRoot, sessionId)) {
    const revision = await readFileRevision(transcriptPath);
    if (revision) return revision;
  }
  return null;
}

/**
 * Builds chat messages from transcript steps. Parallel tool calls in one planner step are
 * followed by their result steps in call order; agy records no tool-call ids.
 */
export function parseAntigravityTranscript(
  steps: readonly TranscriptStep[],
  sessionId: string,
  argumentsEncoded = false,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let turn: TurnBuilder | null = null;

  const abortPendingTools = (): void => {
    for (const pending of (turn)?.pending.splice(0) ?? []) {
      pending.call.status = 'error';
      pending.call.result = ABORTED_TOOL_RESULT;
    }
  };

  const finishTurn = (): void => {
    if (!turn) return;
    // Calls without a result at the end of the transcript may still be running.
    const { assistant, blocks, lastStepAt, requestedAt, toolCalls } = turn;
    if (requestedAt && lastStepAt && lastStepAt >= requestedAt) {
      assistant.completedAt = lastStepAt;
      assistant.durationSeconds = Math.floor((lastStepAt - requestedAt) / 1_000);
    }
    if (assistant.content || blocks.length > 0 || toolCalls.length > 0) {
      if (blocks.length > 0) assistant.contentBlocks = blocks;
      if (toolCalls.length > 0) assistant.toolCalls = toolCalls;
      messages.push(assistant);
    }
    turn = null;
  };

  const startTurn = (stepId: string, timestamp: number, automatic: boolean): TurnBuilder => {
    finishTurn();
    const id = `${sessionId}:${stepId}:assistant`;
    turn = {
      assistant: {
        assistantMessageId: id,
        content: '',
        id,
        role: 'assistant',
        timestamp,
        turnId: id,
        ...(automatic ? { isAutomaticResponse: true } : {}),
      },
      blocks: [],
      pending: [],
      ...(automatic ? {} : { requestedAt: timestamp }),
      toolCalls: [],
    };
    return turn;
  };

  for (const step of steps) {
    const stepId = String(step.step_index ?? messages.length);
    const timestamp = parseTimestamp(step.created_at);
    if (step.type === 'USER_INPUT' || step.type === 'SYSTEM_MESSAGE' || step.type === 'PLANNER_RESPONSE') {
      abortPendingTools();
    }
    switch (step.type) {
      case 'USER_INPUT': {
        finishTurn();
        const content = extractUserRequest(step.content ?? '');
        const id = `${sessionId}:${stepId}:user`;
        messages.push({ content, id, role: 'user', timestamp, userMessageId: id });
        startTurn(stepId, timestamp, false);
        break;
      }
      case 'SYSTEM_MESSAGE': {
        // Background task and subagent reports start a response without a user request. A notice before the
        // current turn has produced anything (agy's restart notice follows the next request) is only context, and
        // a report agy delivers at the start of a turn joins it without counting as its output.
        const current = turn as TurnBuilder | null;
        const answered = current && (current.assistant.content || current.toolCalls.length > 0
          || current.blocks.some(block => block.type !== 'task_notification'));
        const target = !current || answered ? startTurn(stepId, timestamp, true) : current;
        const report = SYSTEM_REPORT_PATTERN.exec(step.content ?? '');
        if (report && report[1] !== 'system' && report[2].trim()) {
          target.blocks.push({ content: report[2].trim(), type: 'task_notification' });
        }
        break;
      }
      case 'CHECKPOINT': {
        if (step.status !== 'DONE') break;
        const current: TurnBuilder = turn ?? startTurn(stepId, timestamp, true);
        current.blocks.push({ type: 'context_compacted' });
        break;
      }
      case 'PLANNER_RESPONSE': {
        const current: TurnBuilder = turn ?? startTurn(stepId, timestamp, true);
        if (step.thinking) appendBlock(current.blocks, 'thinking', step.thinking);
        if (step.content) {
          appendBlock(current.blocks, 'text', step.content);
          current.assistant.content += current.assistant.content ? `\n\n${step.content}` : step.content;
        }
        for (const [index, toolCall] of (step.tool_calls ?? []).entries()) {
          const rawName = typeof toolCall.name === 'string' ? toolCall.name : 'tool';
          const rawInput = decodeArguments(toolCall.args, argumentsEncoded);
          const call: ToolCallInfo = {
            id: `${sessionId}:${stepId}:tool:${index}`,
            input: normalizeAntigravityToolInput(rawName, rawInput),
            name: normalizeAntigravityToolName(rawName, rawInput),
            providerPayload: buildAntigravityToolProviderPayload(rawName, rawInput, undefined),
            status: 'running',
          };
          current.toolCalls.push(call);
          current.blocks.push({ toolId: call.id, type: 'tool_use' });
          current.pending.push({ call, rawInput, rawName });
        }
        break;
      }
      case 'GENERIC': {
        const pending = (turn as TurnBuilder | null)?.pending.shift();
        if (pending) completeTool(pending, step);
        break;
      }
      default:
        break;
    }
    const current = turn as TurnBuilder | null;
    if (current && timestamp > 0 && (step.type === 'PLANNER_RESPONSE' || step.type === 'GENERIC')) {
      current.lastStepAt = timestamp;
    }
  }
  finishTurn();
  return messages;
}

function completeTool(pending: PendingTool, step: TranscriptStep): void {
  const { call, rawName } = pending;
  const text = (step.status === 'ERROR' ? step.error ?? step.content : step.content) ?? '';
  const body = text.replace(RESULT_HEADER_PATTERN, '').replace(BACKGROUND_INSTRUCTIONS_PATTERN, '');
  const result = rawName === 'run_command'
    ? normalizeAntigravityToolResult(rawName, body, { output: body })
    : { content: body, isError: false };
  if (result.content) call.result = result.content;
  if (rawName === 'ask_question') {
    const answers = decodeQuestionAnswers(pending.rawInput, body);
    if (answers) call.resolvedAnswers = answers;
  }
  // A RUNNING command step is one agy moved to the background; the step keeps that status after the task ends,
  // and its outcome arrives as a later task report.
  const running = step.status === 'RUNNING' && rawName !== 'run_command';
  call.status = step.status === 'ERROR' || result.isError ? 'error' : running ? 'running' : 'completed';
  if (call.name === 'Read') call.resultFormat = 'plain';
  if (call.status === 'completed' && isWriteEditTool(call.name)) {
    const diffData = resolveToolDiffData(undefined, call);
    if (diffData) call.diffData = diffData;
  }
}

/**
 * agy records answers as `A<n>: <text>` lines, numbered by question; a multiline answer continues until the next
 * answer line. Unanswered questions have no line.
 */
function decodeQuestionAnswers(input: Record<string, unknown>, result: string): AskUserAnswers | undefined {
  const questions = Array.isArray(input.questions) ? input.questions as unknown[] : [];
  const answers: Record<string, string> = {};
  let current: string | null = null;
  for (const line of result.split('\n')) {
    const match = QUESTION_ANSWER_PATTERN.exec(line);
    if (!match) {
      if (current !== null) answers[current] += `\n${line}`;
      continue;
    }
    const question = questions[Number(match[1]) - 1];
    const text = question && typeof question === 'object' ? (question as { question?: unknown }).question : undefined;
    current = typeof text === 'string' && text ? text : null;
    if (current !== null) answers[current] = match[2];
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

/**
 * agy stores uploads in the session's `.user_uploaded` directory and references them from the user step. Only
 * files there are read; a missing or unsupported file is left out.
 */
async function attachUploadedImages(
  messages: ChatMessage[],
  steps: readonly TranscriptStep[],
  storeRoot: string,
  sessionId: string,
): Promise<void> {
  const uploads = path.join(storeRoot, 'brain', sessionId, '.user_uploaded') + path.sep;
  for (const step of steps) {
    if (step.type !== 'USER_INPUT' || !Array.isArray(step.media)) continue;
    const message = messages.find(entry => entry.id === `${sessionId}:${String(step.step_index)}:user`);
    if (!message) continue;
    const images: ImageAttachment[] = [];
    for (const [index, media] of step.media.entries()) {
      const mediaType = normalizeImageMediaType(media?.mime_type);
      if (!mediaType || typeof media.uri !== 'string') continue;
      const file = path.resolve(media.uri.startsWith('file:') ? fileURLToPath(media.uri) : media.uri);
      if (!file.startsWith(uploads)) continue;
      let data: Buffer;
      try {
        data = await fs.readFile(file);
      } catch {
        continue;
      }
      images.push({
        data: data.toString('base64'),
        id: `${sessionId}:${String(step.step_index)}:image:${index}`,
        mediaType,
        name: path.basename(file),
        size: data.length,
        source: 'file',
      });
    }
    if (images.length > 0) message.images = images;
  }
}

function extractUserRequest(content: string): string {
  return content.match(USER_REQUEST_PATTERN)?.[1] ?? content;
}

function decodeArguments(args: unknown, encoded: boolean): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  if (!encoded) return { ...(args as Record<string, unknown>) };
  return Object.fromEntries(Object.entries(args).map(([key, value]) => {
    if (typeof value !== 'string') return [key, value];
    try {
      return [key, JSON.parse(value) as unknown];
    } catch {
      return [key, value];
    }
  }));
}

function appendBlock(blocks: ContentBlock[], type: 'text' | 'thinking', content: string): void {
  const previous = blocks[blocks.length - 1];
  if (previous?.type === type) previous.content += `\n\n${content}`;
  else blocks.push({ content, type });
}

function parseTimestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
