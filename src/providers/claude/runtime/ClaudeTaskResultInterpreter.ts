import { existsSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, sep } from 'path';

import type {
  ProviderTaskDescription,
  ProviderTaskLaunch,
  ProviderTaskResult,
  ProviderTaskResultContext,
  ProviderTaskResultInterpreter,
  ProviderTaskTerminalStatus,
} from '../../../core/providers/types';
import { extractToolResultContent } from '../../../core/tools/toolResultContent';
import {
  extractAgentIdFromToolUseResult,
  hasAgentOutputReport,
  resolveToolUseResultStatus,
} from '../history/sdkAsyncSubagent';
import { extractFinalResultFromSubagentJSONL } from '../history/subagentJSONL';
import { extractHandbackResult } from '../normalization/claudeSubagentResult';
import { extractXMLTag } from '../normalization/claudeTaskNotification';

/*
 * Legacy history compatibility (2026-09-29, SDK 0.3.283): the SDK documents that "the TaskOutput
 * tool was removed" (Options.taskOutputMaxChars). Current Claude reports background results through
 * <task-notification> and the Agent tool's structured AgentOutput. TaskOutput-era payloads
 * (`retrieval_status`, `not_ready`, the `agents` map, `[Truncated. Full output: ...]` temp files,
 * bare 8-hex task ids) only appear in transcripts and cached snapshots recorded before the removal.
 */
const LEGACY_RUNNING_TASK_STATUSES = new Set(['running', 'pending', 'not_ready']);

function extractAgentIdFromString(value: string): string | null {
  const regexPatterns = [
    /"agent_id"\s*:\s*"([^"]+)"/,
    /"agentId"\s*:\s*"([^"]+)"/,
    /agent_id[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,
    /agentId[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,
  ];

  for (const pattern of regexPatterns) {
    const match = value.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/** The structured report is rendered as-is; the SDK keeps the model-directed trailer out of it. */
function extractAgentOutputReport(toolUseResult: unknown): string | null {
  if (!hasAgentOutputReport(toolUseResult)) return null;
  const text = toolUseResult.content
    .flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('\n');
  return text.trim().length > 0 ? text : null;
}

function isTerminalTaskStatus(record: unknown): boolean {
  return resolveToolUseResultStatus(record, 'running') !== 'running';
}

function isLegacyTaskOutputPayload(payload: string): boolean {
  const parsed = parseJSONRecord(payload);
  return parsed
    ? 'retrieval_status' in parsed || isRecord(parsed.agents) || isRecord(parsed.task)
    : extractXMLTag(payload, 'retrieval_status') !== null || extractXMLTag(payload, 'task_id') !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJSONRecord(value: string): Record<string, unknown> | null {
  const parsed = parseJSONValue(value);
  return isRecord(parsed) ? parsed : null;
}

function parseJSONValue(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return null;
  }
}

export class ClaudeTaskResultInterpreter implements ProviderTaskResultInterpreter {
  private static readonly TRUSTED_OUTPUT_EXT = '.output';
  private static readonly TRUSTED_TMP_ROOTS = ClaudeTaskResultInterpreter.resolveTrustedTmpRoots();

  describeTask(input: Readonly<Record<string, unknown>>): ProviderTaskDescription {
    return {
      mode: this.#resolveTaskMode(input),
      ...(typeof input.description === 'string' ? { description: input.description } : {}),
      ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
    };
  }

  interpretLaunch(result: unknown, isError: boolean, toolUseResult?: unknown): ProviderTaskLaunch {
    const text = extractToolResultContent(result, { fallbackIndent: 2 });
    return {
      mode: this.#inferModeFromTaskResult(text, isError, toolUseResult),
      agentId: extractAgentIdFromToolUseResult(toolUseResult) ?? this.#parseAgentId(text),
      result: text,
    };
  }

  getOutputTaskId(input: Readonly<Record<string, unknown>> | undefined, result?: unknown): string | null {
    return (input ? this.#extractAgentIdFromInput(input) : null)
      ?? this.#inferAgentIdFromResult(extractToolResultContent(result, { fallbackIndent: 2 }));
  }

  interpretResult(result: unknown, isError: boolean, context: ProviderTaskResultContext, toolUseResult?: unknown): ProviderTaskResult {
    const text = extractToolResultContent(result, { fallbackIndent: 2 });
    if (context.mode === 'sync') {
      // Sync reports are answer text. Only the complete native hand-back frame
      // is an envelope; TaskOutput's JSON/XML recovery belongs to async results.
      return {
        status: this.#resolveTerminalStatus(toolUseResult, isError ? 'error' : 'completed'),
        result: extractAgentOutputReport(toolUseResult) ?? extractHandbackResult(text) ?? text,
      };
    }
    const resolvedId = context.agentId ?? this.#inferAgentIdFromResult(text);
    const running = this.#isStillRunningResult(text, isError);
    return {
      status: running
        ? 'running'
        : this.#resolveTerminalStatus(toolUseResult, isError ? 'error' : 'completed'),
      result: running ? text : this.#extractAsyncResult(text, resolvedId ?? '', toolUseResult),
    };
  }

  #resolveTerminalStatus(
    toolUseResult: unknown,
    fallbackStatus: ProviderTaskTerminalStatus,
  ): ProviderTaskTerminalStatus {
    const resolved = resolveToolUseResultStatus(toolUseResult, fallbackStatus);
    return resolved === 'error' || resolved === 'completed' ? resolved : fallbackStatus;
  }

  #resolveTaskMode(taskInput: Record<string, unknown>): 'sync' | 'async' | null {
    if (!Object.prototype.hasOwnProperty.call(taskInput, 'run_in_background')) {
      return null;
    }
    if (taskInput.run_in_background === true) {
      return 'async';
    }
    if (taskInput.run_in_background === false) {
      return 'sync';
    }
    return null;
  }

  #inferModeFromTaskResult(
    taskResult: string,
    isError: boolean,
    taskToolUseResult?: unknown
  ): 'sync' | 'async' {
    if (isError) {
      return 'sync';
    }
    // Sync results carry agentId too, so only an explicit launch status or
    // an output file marks an async launch.
    if (
      resolveToolUseResultStatus(taskToolUseResult, 'completed') === 'running'
      || (isRecord(taskToolUseResult) && typeof taskToolUseResult.outputFile === 'string'
        && taskToolUseResult.outputFile.length > 0)
    ) {
      return 'async';
    }
    // Only promote to async for launch-shaped payloads. Completed sync results
    // can still contain agent metadata in the payload or final output text.
    return this.#parseAgentIdStrict(taskResult) ? 'async' : 'sync';
  }

  #parseAgentIdStrict(result: string): string | null {
    const payload = this.#unwrapTextPayload(result).trim();
    if (!payload) {
      return null;
    }

    const parsed = parseJSONRecord(payload);
    if (parsed) {
      if (isTerminalTaskStatus(parsed)) {
        return null;
      }
      const agentId = extractAgentIdFromToolUseResult(parsed);
      if (agentId) {
        return agentId;
      }
      return isRecord(parsed.task) ? extractAgentIdFromToolUseResult(parsed.task) : null;
    }

    const xmlStatus = extractXMLTag(payload, 'retrieval_status')
      ?? extractXMLTag(payload, 'status');
    if (isTerminalTaskStatus({ status: xmlStatus })) {
      return null;
    }

    const exactLineMatch = payload.match(/^\s*(?:agent_id|agentId)\s*[=:]\s*"?([a-zA-Z0-9_-]+)"?\s*$/i);
    return exactLineMatch?.[1] ?? null;
  }

  #parseAgentId(result: string): string | null {
    const agentId = extractAgentIdFromString(result);
    if (agentId) return agentId;

    const parsed = parseJSONRecord(result);
    if (parsed) {
      const parsedId = extractAgentIdFromToolUseResult(parsed)
        ?? (typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : null);
      if (parsedId) return parsedId;
    }

    // Legacy: a TaskOutput payload could name its task only by a bare 8-hex id.
    // Ordinary result text (commit hashes, colors) must not become an agent id.
    return isLegacyTaskOutputPayload(result) ? result.match(/\b([a-f0-9]{8})\b/)?.[1] ?? null : null;
  }

  // Legacy TaskOutput history compatibility; see the note at the top of this file.
  #isStillRunningResult(result: string, isError: boolean): boolean {
    const payload = this.#unwrapTextPayload(result.trim());
    if (isError || !payload) return false;

    const parsed = parseJSONRecord(payload);
    if (parsed) {
      const status = parsed.retrieval_status ?? parsed.status;
      if (typeof status === 'string' && LEGACY_RUNNING_TASK_STATUSES.has(status)) return true;
      return isRecord(parsed.agents) && Object.values(parsed.agents).some(agent => isRecord(agent)
        && typeof agent.status === 'string' && LEGACY_RUNNING_TASK_STATUSES.has(agent.status.toLowerCase()));
    }

    const lowerResult = payload.toLowerCase();
    if (lowerResult.includes('not_ready') || lowerResult.includes('not ready')) {
      return true;
    }

    const xmlStatus = lowerResult.match(/<status>([^<]+)<\/status>/)?.[1].trim();
    return xmlStatus !== undefined && LEGACY_RUNNING_TASK_STATUSES.has(xmlStatus);
  }

  #extractAsyncResult(result: string, agentId: string, toolUseResult?: unknown): string {
    const structuredResult = this.#extractStructuredResult(toolUseResult)
      ?? extractAgentOutputReport(toolUseResult);
    if (structuredResult !== null) return structuredResult;

    const payload = this.#unwrapTextPayload(result);

    const handbackResult = extractHandbackResult(payload);
    if (handbackResult !== null) return handbackResult;

    const parsed = parseJSONRecord(payload);
    if (parsed) {
      const taskResult = this.#extractResultFromTaskObject(parsed.task);
      if (taskResult) {
        return taskResult;
      }

      // Legacy TaskOutput `agents` map: prefer the owned agent, else the first entry.
      const agents = isRecord(parsed.agents) ? parsed.agents : {};
      const agentKey = agentId && isRecord(agents[agentId]) ? agentId : Object.keys(agents)[0];
      if (agentKey !== undefined) {
        const agent = agents[agentKey];
        return this.#extractResultFromTaskObject(agent) ?? JSON.stringify(agent, null, 2);
      }

      const parsedResult = this.#extractResultFromTaskObject(parsed);
      if (parsedResult) {
        return parsedResult;
      }
    }

    return this.#extractResultFromTaggedPayload(payload) ?? payload;
  }

  // Legacy TaskOutput `toolUseResult` fields (`retrieval_status`, `task`, `result`, `output`).
  #extractStructuredResult(toolUseResult: unknown): string | null {
    if (!isRecord(toolUseResult)) {
      return null;
    }

    if (toolUseResult.retrieval_status === 'error') {
      const errorMsg = typeof toolUseResult.error === 'string' ? toolUseResult.error : 'Task retrieval failed';
      return `Error: ${errorMsg}`;
    }

    return this.#extractResultFromTaskObject(toolUseResult.task)
      ?? this.#extractResultFromTaskObject(toolUseResult);
  }

  #extractResultFromTaskObject(task: unknown): string | null {
    if (!isRecord(task)) {
      return null;
    }
    return this.#extractResultFromCandidateString(task.result)
      ?? this.#extractResultFromCandidateString(task.output);
  }

  #extractResultFromCandidateString(candidate: unknown): string | null {
    if (typeof candidate !== 'string') {
      return null;
    }

    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    return this.#extractResultFromTaggedPayload(trimmed)
      ?? this.#extractResultFromOutputJsonl(trimmed)
      ?? trimmed;
  }

  #inferAgentIdFromResult(result: string): string | null {
    const parsed = parseJSONRecord(result);
    return parsed && isRecord(parsed.agents) ? Object.keys(parsed.agents)[0] ?? null : null;
  }

  #unwrapTextPayload(raw: string): string {
    const parsed = parseJSONValue(raw);
    if (parsed !== null) {
      if (Array.isArray(parsed)) {
        const textBlock = (parsed as unknown[]).find((block) => isRecord(block) && typeof block.text === 'string');
        if (isRecord(textBlock) && typeof textBlock.text === 'string') return textBlock.text;
      } else if (isRecord(parsed) && typeof parsed.text === 'string') {
        return parsed.text;
      }
    }
    return raw;
  }

  #extractResultFromTaggedPayload(payload: string): string | null {
    const directResult = extractXMLTag(payload, 'result');
    if (directResult) return directResult;

    const outputContent = extractXMLTag(payload, 'output');
    if (!outputContent) return null;

    const extractedFromJsonl = this.#extractResultFromOutputJsonl(outputContent);
    if (extractedFromJsonl) return extractedFromJsonl;

    const nestedResult = extractXMLTag(outputContent, 'result');
    if (nestedResult) return nestedResult;

    const trimmed = outputContent.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  #extractResultFromOutputJsonl(outputContent: string): string | null {
    const inlineResult = extractFinalResultFromSubagentJSONL(outputContent);
    if (inlineResult) {
      return inlineResult;
    }

    const fullOutputPath = this.#extractFullOutputPath(outputContent);
    if (!fullOutputPath) {
      return null;
    }

    const fullOutput = this.#readFullOutputFile(fullOutputPath);
    if (!fullOutput) {
      return null;
    }

    return extractFinalResultFromSubagentJSONL(fullOutput);
  }

  // Legacy TaskOutput truncation marker pointing at a temp file.
  #extractFullOutputPath(content: string): string | null {
    const truncatedPattern = /\[Truncated\.\s*Full output:\s*([^\]\n]+)\]/i;
    const match = content.match(truncatedPattern);
    if (!match || !match[1]) {
      return null;
    }

    const outputPath = match[1].trim();
    return outputPath.length > 0 ? outputPath : null;
  }

  #readFullOutputFile(fullOutputPath: string): string | null {
    try {
      if (!this.#isTrustedOutputPath(fullOutputPath)) {
        return null;
      }

      if (!existsSync(fullOutputPath)) {
        return null;
      }

      const fileContent = readFileSync(fullOutputPath, 'utf-8');
      const trimmed = fileContent.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  #extractAgentIdFromInput(input: Record<string, unknown>): string | null {
    const agentId = (input.task_id as string) || (input.agentId as string) || (input.agent_id as string);
    return agentId || null;
  }

  private static resolveTrustedTmpRoots(): string[] {
    const roots = new Set<string>();
    const candidates = [tmpdir(), '/tmp', '/private/tmp'];
    for (const candidate of candidates) {
      try {
        roots.add(realpathSync(candidate));
      } catch {
        // Ignore unavailable temp roots.
      }
    }
    return Array.from(roots);
  }

  #isTrustedOutputPath(fullOutputPath: string): boolean {
    if (!isAbsolute(fullOutputPath)) {
      return false;
    }

    if (!fullOutputPath.toLowerCase().endsWith(ClaudeTaskResultInterpreter.TRUSTED_OUTPUT_EXT)) {
      return false;
    }

    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(fullOutputPath);
    } catch {
      return false;
    }

    return ClaudeTaskResultInterpreter.TRUSTED_TMP_ROOTS.some((root) =>
      resolvedPath === root || resolvedPath.startsWith(`${root}${sep}`)
    );
  }
}
