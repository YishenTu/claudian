import { normalizeToolProviderPayload } from '../../core/tools/toolProviderPayload';
import type { StreamChunk, ToolProviderPayload } from '../../core/types';
import type { SDKToolUseResult } from '../../core/types/diff';
import type { ACPToolCall, ACPToolCallUpdate } from './types';

interface ACPToolStreamState {
  input: Record<string, unknown>;
  rawInput?: unknown;
  rawName: string;
  rawNameProvenance: ACPToolRawNameProvenance;
  rawOutput?: unknown;
}

export type ACPToolRawNameProvenance = 'fallback' | 'kind' | 'mapped-kind' | 'title';

export interface ACPResolvedToolRawName {
  provenance: ACPToolRawNameProvenance;
  rawName: string;
}

export interface ACPToolStreamPresentationAdapter {
  normalizeToolInput(rawName: string | undefined, input: Record<string, unknown>): Record<string, unknown>;
  normalizeToolName(rawName: string | undefined): string;
  normalizeToolUseResult(
    rawName: string | undefined,
    input: Record<string, unknown>,
    rawOutput: unknown,
    rawInput: unknown,
  ): SDKToolUseResult | undefined;
  resolveRawToolName(
    currentRawName: ACPResolvedToolRawName | undefined,
    update: {
      kind?: string | null;
      title?: string | null;
    },
  ): ACPResolvedToolRawName;
}

export class ACPToolStreamAdapter {
  private readonly toolStates = new Map<string, ACPToolStreamState>();

  constructor(private readonly adapter: ACPToolStreamPresentationAdapter) {}

  reset(): void {
    this.toolStates.clear();
  }

  normalizeToolCall(toolCall: ACPToolCall, chunks: StreamChunk[]): StreamChunk[] {
    const state = this.#updateToolState(undefined, {
      kind: toolCall.kind,
      rawInput: toolCall.rawInput,
      rawOutput: toolCall.rawOutput,
      title: toolCall.title,
    });
    this.toolStates.set(toolCall.toolCallId, state);
    return chunks.map((chunk) => this.#normalizeChunk(chunk, state));
  }

  normalizeToolCallUpdate(toolCallUpdate: ACPToolCallUpdate, chunks: StreamChunk[]): StreamChunk[] {
    const current = this.toolStates.get(toolCallUpdate.toolCallId);
    const state = this.#updateToolState(current, {
      kind: toolCallUpdate.kind,
      rawInput: toolCallUpdate.rawInput,
      rawOutput: toolCallUpdate.rawOutput,
      title: toolCallUpdate.title,
    });
    this.toolStates.set(toolCallUpdate.toolCallId, state);

    const result: StreamChunk[] = [];
    const providerPayloadFields = this.#buildProviderPayloadFields(state);
    if (
      toolCallUpdate.rawInput !== undefined
      || state.rawName !== current?.rawName
      || (
        toolCallUpdate.rawOutput !== undefined
        && providerPayloadFields.providerPayload !== undefined
      )
    ) {
      result.push({
        id: toolCallUpdate.toolCallId,
        input: state.input,
        name: this.adapter.normalizeToolName(state.rawName),
        ...providerPayloadFields,
        type: 'tool_use',
      });
    }

    for (const chunk of chunks) {
      result.push(this.#normalizeChunk(chunk, state));
    }

    return result;
  }

  #updateToolState(
    current: ACPToolStreamState | undefined,
    update: {
      kind?: string | null;
      rawInput?: unknown;
      rawOutput?: unknown;
      title?: string | null;
    },
  ): ACPToolStreamState {
    const nextRawName = this.adapter.resolveRawToolName(current ? {
      provenance: current.rawNameProvenance,
      rawName: current.rawName,
    } : undefined, update);
    const nextInput = current?.input ?? {};
    const rawInput = update.rawInput !== undefined ? update.rawInput : current?.rawInput;
    const rawOutput = update.rawOutput !== undefined ? update.rawOutput : current?.rawOutput;

    if (update.rawInput !== undefined) {
      const normalizedRawInput = normalizeRawToolInput(update.rawInput);
      return this.#buildToolState(
        nextRawName,
        { ...nextInput, ...normalizedRawInput },
        rawInput,
        rawOutput,
      );
    }

    if (
      nextRawName.rawName !== current?.rawName
      || nextRawName.provenance !== current?.rawNameProvenance
    ) {
      return this.#buildToolState(nextRawName, nextInput, rawInput, rawOutput);
    }

    return current && rawOutput === current.rawOutput
      ? current
      : this.#buildToolState(nextRawName, nextInput, rawInput, rawOutput);
  }

  #buildToolState(
    rawName: ACPResolvedToolRawName,
    input: Record<string, unknown>,
    rawInput?: unknown,
    rawOutput?: unknown,
  ): ACPToolStreamState {
    return {
      input: this.adapter.normalizeToolInput(rawName.rawName, input),
      rawInput,
      rawName: rawName.rawName,
      rawNameProvenance: rawName.provenance,
      rawOutput,
    };
  }

  #normalizeChunk(
    chunk: StreamChunk,
    state: ACPToolStreamState,
  ): StreamChunk {
    switch (chunk.type) {
      case 'tool_use':
        return {
          ...chunk,
          input: state.input,
          name: this.adapter.normalizeToolName(state.rawName),
          ...this.#buildProviderPayloadFields(state),
        };
      case 'tool_result': {
        const providerToolUseResult = this.adapter.normalizeToolUseResult(
          state.rawName,
          state.input,
          state.rawOutput,
          state.rawInput,
        );
        const toolUseResult = mergeToolUseResults(chunk.toolUseResult, providerToolUseResult);
        return toolUseResult
          ? { ...chunk, toolUseResult }
          : chunk;
      }
      default:
        return chunk;
    }
  }

  #buildProviderPayloadFields(
    state: ACPToolStreamState,
  ): { providerPayload?: ToolProviderPayload } {
    const result = this.adapter.normalizeToolUseResult(
      state.rawName,
      state.input,
      state.rawOutput,
      state.rawInput,
    );
    const providerPayload = normalizeToolProviderPayload(result?.providerPayload);
    return providerPayload ? { providerPayload } : {};
  }
}

function mergeToolUseResults(
  nativeResult: SDKToolUseResult | undefined,
  providerResult: SDKToolUseResult | undefined,
): SDKToolUseResult | undefined {
  if (!nativeResult) return providerResult;
  if (!providerResult) return nativeResult;
  return { ...nativeResult, ...providerResult };
}

function normalizeRawToolInput(rawInput: unknown): Record<string, unknown> {
  return rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
    ? rawInput as Record<string, unknown>
    : {};
}
