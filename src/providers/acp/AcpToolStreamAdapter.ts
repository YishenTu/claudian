import { normalizeToolProviderPayload } from '../../core/tools/toolProviderPayload';
import type { StreamChunk, ToolProviderPayload } from '../../core/types';
import type { SDKToolUseResult } from '../../core/types/diff';
import type { AcpToolCall, AcpToolCallUpdate } from './types';

interface AcpToolStreamState {
  input: Record<string, unknown>;
  rawInput?: unknown;
  rawName: string;
  rawNameProvenance: AcpToolRawNameProvenance;
  rawOutput?: unknown;
}

export type AcpToolRawNameProvenance = 'fallback' | 'kind' | 'mapped-kind' | 'title';

export interface AcpResolvedToolRawName {
  provenance: AcpToolRawNameProvenance;
  rawName: string;
}

export interface AcpToolStreamPresentationAdapter {
  normalizeToolInput(rawName: string | undefined, input: Record<string, unknown>): Record<string, unknown>;
  normalizeToolName(rawName: string | undefined): string;
  normalizeToolUseResult(
    rawName: string | undefined,
    input: Record<string, unknown>,
    rawOutput: unknown,
    rawInput: unknown,
  ): SDKToolUseResult | undefined;
  resolveRawToolName(
    currentRawName: AcpResolvedToolRawName | undefined,
    update: {
      kind?: string | null;
      title?: string | null;
    },
  ): AcpResolvedToolRawName;
}

export class AcpToolStreamAdapter {
  private readonly toolStates = new Map<string, AcpToolStreamState>();

  constructor(private readonly adapter: AcpToolStreamPresentationAdapter) {}

  reset(): void {
    this.toolStates.clear();
  }

  normalizeToolCall(toolCall: AcpToolCall, chunks: StreamChunk[]): StreamChunk[] {
    const state = this.updateToolState(undefined, {
      kind: toolCall.kind,
      rawInput: toolCall.rawInput,
      rawOutput: toolCall.rawOutput,
      title: toolCall.title,
    });
    this.toolStates.set(toolCall.toolCallId, state);
    return chunks.map((chunk) => this.normalizeChunk(chunk, state));
  }

  normalizeToolCallUpdate(toolCallUpdate: AcpToolCallUpdate, chunks: StreamChunk[]): StreamChunk[] {
    const current = this.toolStates.get(toolCallUpdate.toolCallId);
    const state = this.updateToolState(current, {
      kind: toolCallUpdate.kind,
      rawInput: toolCallUpdate.rawInput,
      rawOutput: toolCallUpdate.rawOutput,
      title: toolCallUpdate.title,
    });
    this.toolStates.set(toolCallUpdate.toolCallId, state);

    const result: StreamChunk[] = [];
    const providerPayloadFields = this.buildProviderPayloadFields(state);
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
      result.push(this.normalizeChunk(chunk, state));
    }

    return result;
  }

  private updateToolState(
    current: AcpToolStreamState | undefined,
    update: {
      kind?: string | null;
      rawInput?: unknown;
      rawOutput?: unknown;
      title?: string | null;
    },
  ): AcpToolStreamState {
    const nextRawName = this.adapter.resolveRawToolName(current ? {
      provenance: current.rawNameProvenance,
      rawName: current.rawName,
    } : undefined, update);
    const nextInput = current?.input ?? {};
    const rawInput = update.rawInput !== undefined ? update.rawInput : current?.rawInput;
    const rawOutput = update.rawOutput !== undefined ? update.rawOutput : current?.rawOutput;

    if (update.rawInput !== undefined) {
      const normalizedRawInput = normalizeRawToolInput(update.rawInput);
      return this.buildToolState(
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
      return this.buildToolState(nextRawName, nextInput, rawInput, rawOutput);
    }

    return current && rawOutput === current.rawOutput
      ? current
      : this.buildToolState(nextRawName, nextInput, rawInput, rawOutput);
  }

  private buildToolState(
    rawName: AcpResolvedToolRawName,
    input: Record<string, unknown>,
    rawInput?: unknown,
    rawOutput?: unknown,
  ): AcpToolStreamState {
    return {
      input: this.adapter.normalizeToolInput(rawName.rawName, input),
      rawInput,
      rawName: rawName.rawName,
      rawNameProvenance: rawName.provenance,
      rawOutput,
    };
  }

  private normalizeChunk(
    chunk: StreamChunk,
    state: AcpToolStreamState,
  ): StreamChunk {
    switch (chunk.type) {
      case 'tool_use':
        return {
          ...chunk,
          input: state.input,
          name: this.adapter.normalizeToolName(state.rawName),
          ...this.buildProviderPayloadFields(state),
        };
      case 'tool_result': {
        const toolUseResult = this.adapter.normalizeToolUseResult(
          state.rawName,
          state.input,
          state.rawOutput,
          state.rawInput,
        );
        return toolUseResult
          ? { ...chunk, toolUseResult }
          : chunk;
      }
      default:
        return chunk;
    }
  }

  private buildProviderPayloadFields(
    state: AcpToolStreamState,
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

function normalizeRawToolInput(rawInput: unknown): Record<string, unknown> {
  return rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
    ? rawInput as Record<string, unknown>
    : {};
}
