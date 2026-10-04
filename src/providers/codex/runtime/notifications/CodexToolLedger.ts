import type { StreamChunk } from '@/core/types';

import { mergeApplyPatchInputs } from './codexItemToolProjection';

export interface RawToolResult {
  content: string;
  isError: boolean;
}

/**
 * Turn-scoped tool lifecycle facts shared across the notification router's correlators.
 *
 * Raw response items and canonical app-server items can describe the same call.
 * Each lifecycle records here what the other must not publish again.
 */
export class CodexToolLedger {
  /** Calls whose identity was published from a raw response item. */
  readonly rawStartedIds = new Set<string>();
  /** Canonical items whose start has been handled. */
  readonly canonicalStartedIds = new Set<string>();
  /** Canonical items whose completion has been handled. */
  readonly canonicalCompletedIds = new Set<string>();
  /** Normalized requested inputs, by raw call ID or by the canonical item that adopted the request. */
  readonly requestedInputs = new Map<string, Record<string, unknown>>();
  /** Raw results waiting for the canonical completion that publishes them. */
  readonly pendingRawResults = new Map<string, RawToolResult>();
  /** Calls whose terminal result was published outside canonical completion. */
  readonly emittedResultIds = new Set<string>();
  /** Raw function calls still waiting for output. */
  readonly inFlightRawCallIds = new Set<string>();
  /** apply_patch inputs accumulated across raw calls, patch updates, and file change items. */
  readonly #fileChangeInputs = new Map<string, Record<string, unknown>>();

  /** Merges a newer view of a file change into what is known; returns the merged input. */
  rememberFileChangeInput(id: string, input: Record<string, unknown>): Record<string, unknown> {
    const merged = mergeApplyPatchInputs(this.#fileChangeInputs.get(id), input);
    this.#fileChangeInputs.set(id, merged);
    return merged;
  }

  consumeRawResult(callId: string): RawToolResult | undefined {
    const result = this.pendingRawResults.get(callId);
    this.pendingRawResults.delete(callId);
    return result;
  }

  clear(): void {
    this.rawStartedIds.clear();
    this.canonicalStartedIds.clear();
    this.canonicalCompletedIds.clear();
    this.requestedInputs.clear();
    this.pendingRawResults.clear();
    this.emittedResultIds.clear();
    this.inFlightRawCallIds.clear();
    this.#fileChangeInputs.clear();
  }
}

export interface CodexToolChunkSink {
  emit(chunk: CodexToolChunk): void;
  /**
   * Publishes a tool card at an assistant-text boundary: text after it starts a new segment.
   * Refinements of an already visible card and lifecycle anchors use `emit`.
   */
  emitToolUse(chunk: CodexToolUseChunk): void;
}

export type CodexToolUseChunk = Extract<StreamChunk, { type: 'tool_use' }>;
export type CodexToolChunk = Extract<StreamChunk, { type: 'tool_use' | 'tool_result' | 'tool_output' }>;
