import { normalizeToolProviderPayload } from '../../core/tools/toolProviderPayload';
import { mergeToolResultDetails } from '../../core/tools/toolResultDetails';
import type { StreamChunk, ToolProviderPayload, ToolResultDetails } from '../../core/types';
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
  /** Input is the latest raw snapshot, never an earlier presentation; raw output can identify the target. */
  normalizeToolInput(rawName: string | undefined, input: Record<string, unknown>, rawOutput?: unknown): Record<string, unknown>;
  /** Raw input/output let dispatcher tools present the tool they dispatch to. */
  normalizeToolName(rawName: string | undefined, rawInput?: unknown, rawOutput?: unknown): string;
  /** Provider-specific result fields; they override the shared ACP diff field by field. */
  normalizeToolResultDetails(
    rawName: string | undefined,
    input: Record<string, unknown>,
    rawOutput: unknown,
    rawInput: unknown,
  ): ToolResultDetails | undefined;
  /** Lossless native fields attached to the tool's start and result. */
  buildToolProviderPayload?(
    rawName: string | undefined,
    rawInput: unknown,
    rawOutput: unknown,
  ): ToolProviderPayload | undefined;
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
        name: this.adapter.normalizeToolName(state.rawName, state.rawInput, state.rawOutput),
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
    const rawInput = update.rawInput !== undefined ? update.rawInput : current?.rawInput;
    const rawOutput = update.rawOutput !== undefined ? update.rawOutput : current?.rawOutput;
    if (
      current && rawInput === current.rawInput && rawOutput === current.rawOutput
      && nextRawName.rawName === current.rawName
      && nextRawName.provenance === current.rawNameProvenance
    ) return current;

    return {
      input: this.adapter.normalizeToolInput(nextRawName.rawName, normalizeRawToolInput(rawInput), rawOutput),
      rawInput,
      rawName: nextRawName.rawName,
      rawNameProvenance: nextRawName.provenance,
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
          name: this.adapter.normalizeToolName(state.rawName, state.rawInput, state.rawOutput),
          ...this.#buildProviderPayloadFields(state),
        };
      case 'tool_result': {
        const resultDetails = mergeToolResultDetails(chunk.resultDetails, this.adapter.normalizeToolResultDetails(
          state.rawName,
          state.input,
          state.rawOutput,
          state.rawInput,
        ));
        return {
          ...chunk,
          ...(resultDetails ? { resultDetails } : {}),
          ...this.#buildProviderPayloadFields(state),
        };
      }
      default:
        return chunk;
    }
  }

  #buildProviderPayloadFields(
    state: ACPToolStreamState,
  ): { providerPayload?: ToolProviderPayload } {
    const providerPayload = normalizeToolProviderPayload(
      this.adapter.buildToolProviderPayload?.(state.rawName, state.rawInput, state.rawOutput),
    );
    return providerPayload ? { providerPayload } : {};
  }
}

function normalizeRawToolInput(rawInput: unknown): Record<string, unknown> {
  return rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
    ? rawInput as Record<string, unknown>
    : {};
}
