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
  extractXMLTag,
  resolveToolUseResultStatus,
} from '../history/ClaudeHistoryStore';
import { extractFinalResultFromSubagentJSONL } from '../history/subagentJSONL';

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

function extractResultFromTaskObject(task: unknown): string | null {
  if (!task || typeof task !== 'object') {
    return null;
  }

  const record = task as Record<string, unknown>;
  const result = typeof record.result === 'string' ? record.result.trim() : '';
  if (result.length > 0) {
    return result;
  }

  const output = typeof record.output === 'string' ? record.output.trim() : '';
  return output.length > 0 ? output : null;
}

function extractTextFromContentBlocks(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const firstTextBlock = (content as Array<Record<string, unknown>>)
    .find(block => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string');
  if (!firstTextBlock || typeof firstTextBlock.text !== 'string') {
    return null;
  }

  const text = firstTextBlock.text.trim();
  return text.length > 0 ? text : null;
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
      agentId: this.#extractAgentId(toolUseResult) ?? this.#parseAgentId(text),
      result: text,
    };
  }

  getOutputTaskId(input: Readonly<Record<string, unknown>> | undefined, result?: unknown): string | null {
    return (input ? this.#extractAgentIdFromInput(input) : null)
      ?? this.#inferAgentIdFromResult(extractToolResultContent(result, { fallbackIndent: 2 }));
  }

  interpretResult(result: unknown, isError: boolean, context: ProviderTaskResultContext, toolUseResult?: unknown): ProviderTaskResult {
    const text = extractToolResultContent(result, { fallbackIndent: 2 });
    const resolvedId = context.agentId ?? this.#inferAgentIdFromResult(text);
    const running = context.mode === 'async' && this.#isStillRunningResult(text, isError);
    return {
      status: running
        ? 'running'
        : this.#resolveTerminalStatus(toolUseResult, isError ? 'error' : 'completed'),
      result: running ? text : this.#extractAgentResult(text, resolvedId ?? '', toolUseResult),
    };
  }

  #hasAsyncLaunchMarker(toolUseResult: unknown): boolean {
    if (!toolUseResult || typeof toolUseResult !== 'object') {
      return false;
    }

    const record = toolUseResult as Record<string, unknown>;
    if (record.isAsync === true) {
      return true;
    }

    const rawStatus = record.retrieval_status ?? record.status;
    if (typeof rawStatus === 'string' && rawStatus.toLowerCase() === 'async_launched') {
      return true;
    }

    // Sync Task results can still carry agentId metadata, so only treat
    // output files as async when an explicit async marker is otherwise absent.
    return typeof record.outputFile === 'string' && record.outputFile.length > 0;
  }

  #extractAgentId(toolUseResult: unknown): string | null {
    const directId = extractAgentIdFromToolUseResult(toolUseResult);
    if (directId) {
      return directId;
    }

    if (!toolUseResult || typeof toolUseResult !== 'object') {
      return null;
    }

    const record = toolUseResult as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      for (const block of record.content) {
        if (typeof block === 'string') {
          const extracted = extractAgentIdFromString(block);
          if (extracted) {
            return extracted;
          }
          continue;
        }

        if (!block || typeof block !== 'object') {
          continue;
        }

        const text = (block as Record<string, unknown>).text;
        if (typeof text !== 'string') {
          continue;
        }

        const extracted = extractAgentIdFromString(text);
        if (extracted) {
          return extracted;
        }
      }
    }

    if (typeof record.content === 'string') {
      return extractAgentIdFromString(record.content);
    }

    return null;
  }

  #extractStructuredResult(toolUseResult: unknown): string | null {
    if (!toolUseResult || typeof toolUseResult !== 'object') {
      return null;
    }

    const record = toolUseResult as Record<string, unknown>;
    if (record.retrieval_status === 'error') {
      const errorMsg = typeof record.error === 'string' ? record.error : 'Task retrieval failed';
      return `Error: ${errorMsg}`;
    }

    const taskResult = extractResultFromTaskObject(record.task);
    if (taskResult) {
      return taskResult;
    }

    const result = typeof record.result === 'string' ? record.result.trim() : '';
    if (result.length > 0) {
      return result;
    }

    const output = typeof record.output === 'string' ? record.output.trim() : '';
    if (output.length > 0) {
      return output;
    }

    return extractTextFromContentBlocks(record.content);
  }

  #resolveTerminalStatus(
    toolUseResult: unknown,
    fallbackStatus: ProviderTaskTerminalStatus,
  ): ProviderTaskTerminalStatus {
    const resolved = resolveToolUseResultStatus(toolUseResult, fallbackStatus);
    if (resolved === 'error') {
      return 'error';
    }

    if (resolved === 'completed') {
      return 'completed';
    }

    return fallbackStatus;
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
    if (this.#hasAsyncLaunchMarker(taskToolUseResult)) {
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
      if (this.#hasTerminalTaskStatus(parsed)) {
        return null;
      }

      const directAgentId = this.#extractAgentIdFromRecord(parsed);
      if (directAgentId) {
        return directAgentId;
      }

      const taskRecord = parsed.task;
      if (isRecord(taskRecord)) {
        return this.#extractAgentIdFromRecord(taskRecord);
      }
    }

    const xmlStatus = extractXMLTag(payload, 'retrieval_status')
      ?? extractXMLTag(payload, 'status');
    if (this.#isTerminalTaskStatusValue(xmlStatus)) {
      return null;
    }

    const exactLineMatch = payload.match(/^\s*(?:agent_id|agentId)\s*[=:]\s*"?([a-zA-Z0-9_-]+)"?\s*$/i);
    return exactLineMatch?.[1] ?? null;
  }

  #hasTerminalTaskStatus(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    const rawStatus = record.retrieval_status ?? record.status;
    return this.#isTerminalTaskStatusValue(rawStatus);
  }

  #isTerminalTaskStatusValue(rawStatus: unknown): boolean {
    if (typeof rawStatus !== 'string') {
      return false;
    }

    const normalized = rawStatus.toLowerCase();
    return normalized === 'completed' || normalized === 'success' || normalized === 'error';
  }

  #extractAgentIdFromRecord(record: Record<string, unknown>): string | null {
    const direct = record.agent_id ?? record.agentId;
    if (typeof direct === 'string' && direct.length > 0) {
      return direct;
    }

    const data = record.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }

    const nested = (data as Record<string, unknown>).agent_id ?? (data as Record<string, unknown>).agentId;
    return typeof nested === 'string' && nested.length > 0 ? nested : null;
  }

  #isStillRunningResult(result: string, isError: boolean): boolean {
    const trimmed = result?.trim() || '';
    const payload = this.#unwrapTextPayload(trimmed);

    if (isError) return false;
    if (!trimmed) return false;

    const parsed = parseJSONRecord(payload);
    if (parsed) {
      const status = parsed.retrieval_status ?? parsed.status;
      const agents = isRecord(parsed.agents) ? parsed.agents : null;
      const hasAgents = agents !== null && Object.keys(agents).length > 0;

      if (status === 'not_ready' || status === 'running' || status === 'pending') {
        return true;
      }

      if (hasAgents && agents) {
        const agentStatuses = Object.values(agents)
          .map((agent) => (isRecord(agent) && typeof agent.status === 'string') ? agent.status.toLowerCase() : '');
        const anyRunning = agentStatuses.some(s =>
          s === 'running' || s === 'pending' || s === 'not_ready'
        );
        if (anyRunning) return true;
        return false;
      }

      if (status === 'success' || status === 'completed') {
        return false;
      }

      return false;
    }

    const lowerResult = payload.toLowerCase();
    if (lowerResult.includes('not_ready') || lowerResult.includes('not ready')) {
      return true;
    }

    const xmlStatusMatch = lowerResult.match(/<status>([^<]+)<\/status>/);
    if (xmlStatusMatch) {
      const status = xmlStatusMatch[1].trim();
      if (status === 'running' || status === 'pending' || status === 'not_ready') {
        return true;
      }
    }

    return false;
  }

  #extractAgentResult(result: string, agentId: string, toolUseResult?: unknown): string {
    const structuredResult = this.#extractStructuredResult(toolUseResult);
    const normalizedStructuredResult = this.#extractResultFromCandidateString(structuredResult);
    if (normalizedStructuredResult) {
      return normalizedStructuredResult;
    }
    if (structuredResult) {
      return structuredResult;
    }

    const payload = this.#unwrapTextPayload(result);

    const parsed = parseJSONRecord(payload);
    if (parsed) {
      const taskResult = this.#extractResultFromTaskObject(parsed.task);
      if (taskResult) {
        return taskResult;
      }

      const agents = isRecord(parsed.agents) ? parsed.agents : null;
      const agentData = agents && agentId ? agents[agentId] : null;
      if (isRecord(agentData)) {
        const parsedResult = this.#extractResultFromCandidateString(agentData.result);
        if (parsedResult) {
          return parsedResult;
        }
        const parsedOutput = this.#extractResultFromCandidateString(agentData.output);
        if (parsedOutput) {
          return parsedOutput;
        }
        return JSON.stringify(agentData, null, 2);
      }

      if (agents) {
        const agentIds = Object.keys(agents);
        if (agentIds.length > 0) {
          const firstAgent = agents[agentIds[0]];
          if (isRecord(firstAgent)) {
            const parsedResult = this.#extractResultFromCandidateString(firstAgent.result);
            if (parsedResult) {
              return parsedResult;
            }
            const parsedOutput = this.#extractResultFromCandidateString(firstAgent.output);
            if (parsedOutput) {
              return parsedOutput;
            }
          }
          return JSON.stringify(firstAgent, null, 2);
        }
      }

      const parsedResult = this.#extractResultFromCandidateString(parsed.result);
      if (parsedResult) {
        return parsedResult;
      }

      const parsedOutput = this.#extractResultFromCandidateString(parsed.output);
      if (parsedOutput) {
        return parsedOutput;
      }
    }

    const taggedResult = this.#extractResultFromTaggedPayload(payload);
    if (taggedResult) {
      return taggedResult;
    }

    return payload;
  }

  #extractResultFromTaskObject(task: unknown): string | null {
    if (!task || typeof task !== 'object') {
      return null;
    }
    const taskRecord = task as Record<string, unknown>;
    return this.#extractResultFromCandidateString(taskRecord.result)
      ?? this.#extractResultFromCandidateString(taskRecord.output);
  }

  #extractResultFromCandidateString(candidate: unknown): string | null {
    if (typeof candidate !== 'string') {
      return null;
    }

    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    const taggedResult = this.#extractResultFromTaggedPayload(trimmed);
    if (taggedResult) {
      return taggedResult;
    }

    const jsonlResult = this.#extractResultFromOutputJsonl(trimmed);
    if (jsonlResult) {
      return jsonlResult;
    }

    return trimmed;
  }

  #parseAgentId(result: string): string | null {
    const agentId = extractAgentIdFromString(result) ?? result.match(/\b([a-f0-9]{8})\b/)?.[1];
    if (agentId) return agentId;

    const parsed = parseJSONRecord(result);
    if (parsed) {
      const agentId = parsed.agent_id || parsed.agentId;

      if (typeof agentId === 'string' && agentId.length > 0) {
        return agentId;
      }

      const data = parsed.data;
      if (isRecord(data) && typeof data.agent_id === 'string') {
        return data.agent_id;
      }

      if (parsed.id && typeof parsed.id === 'string') {
        return parsed.id;
      }
    }

    return null;
  }

  #inferAgentIdFromResult(result: string): string | null {
    const parsed = parseJSONRecord(result);
    if (parsed) {
      const agents = isRecord(parsed.agents) ? parsed.agents : null;
      if (agents) {
        return Object.keys(agents)[0] ?? null;
      }
    }
    return null;
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
