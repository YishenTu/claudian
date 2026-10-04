import {
  appendCodexCommandOutput,
  decodeCodexExecEnvelopeCalls,
  extractCodexExecCellId,
  isCodexInternalToolCall,
  isCodexSilentWriteStdinCall,
  isCodexToolOutputError,
  normalizeCodexToolCall,
  normalizeCodexToolInput,
  parseCodexArguments,
  readCodexExecCellIdArgument,
  stringifyCodexToolOutput,
} from '@/providers/codex/normalization/codexToolNormalization';

import type { CodexCommandCorrelator } from './CodexCommandCorrelator';
import type { CodexDeferredExecCorrelator } from './CodexDeferredExecCorrelator';
import { normalizeRawToolOutput } from './codexItemToolProjection';
import { firstString } from './codexNotificationValues';
import type { CodexToolChunkSink, CodexToolLedger } from './CodexToolLedger';

interface WrappedWaitCall {
  commandCallId: string;
  cellId: string;
}

interface PendingWrappedWaitCall {
  cellId: string;
  rawArguments: Record<string, unknown>;
}

/**
 * Tracks tool calls reported as raw response items: their publication, their output,
 * and Code Mode continuations (`wait` calls on yielded script cells).
 *
 * Bash calls are paired with canonical commands through the command correlator, and
 * non-Bash script envelopes are handed to the deferred exec correlator.
 */
export class CodexRawToolCallTracker {
  #seenCallIds = new Set<string>();
  #pendingOutputItemsByCallId = new Map<string, Record<string, unknown>>();
  #toolNamesByCallId = new Map<string, string>();
  #handledOutputCallIds = new Set<string>();
  /** Calls whose raw output is terminal unless a canonical completion also arrives. */
  #immediateOutputCallIds = new Set<string>();
  #wrappedCommandCallIdsByCellId = new Map<string, string>();
  #wrappedCommandOutputByCallId = new Map<string, string>();
  #wrappedWaitCallsByCallId = new Map<string, WrappedWaitCall>();
  #pendingWrappedWaitCallsByCallId = new Map<string, PendingWrappedWaitCall>();
  #canonicalPrefilledCommandCallIds = new Set<string>();
  /** Yielded cells of scripts whose output is withheld, and the calls whose output carries them. */
  #withheldExecCellIds = new Set<string>();
  #withheldOutputCallIds = new Set<string>();
  #suppressedCallIds = new Set<string>();
  #ignoredLateOutputCallIds = new Set<string>();

  constructor(
    private readonly sink: CodexToolChunkSink,
    private readonly ledger: CodexToolLedger,
    private readonly commands: CodexCommandCorrelator,
    private readonly deferred: CodexDeferredExecCorrelator,
  ) {}

  reset(): void {
    this.#seenCallIds.clear();
    this.#pendingOutputItemsByCallId.clear();
    this.#toolNamesByCallId.clear();
    this.#handledOutputCallIds.clear();
    this.#immediateOutputCallIds.clear();
    this.#wrappedCommandCallIdsByCellId.clear();
    this.#wrappedCommandOutputByCallId.clear();
    this.#wrappedWaitCallsByCallId.clear();
    this.#pendingWrappedWaitCallsByCallId.clear();
    this.#canonicalPrefilledCommandCallIds.clear();
    this.#withheldExecCellIds.clear();
    this.#withheldOutputCallIds.clear();
    this.#suppressedCallIds.clear();
    this.#ignoredLateOutputCallIds.clear();
  }

  handleFunctionCall(item: Record<string, unknown>): void {
    const rawName = firstString(item.name, item.type);
    const callId = this.#admitCall(item);
    if (!callId) {
      return;
    }
    const rawArguments = parseRawArguments(item);
    if (rawName === 'wait') {
      const cellId = readCodexExecCellIdArgument(rawArguments);
      if (cellId && this.#withheldExecCellIds.delete(cellId)) {
        this.#withheldOutputCallIds.add(callId);
        return;
      }
      const commandCallId = cellId
        ? this.#wrappedCommandCallIdsByCellId.get(cellId)
        : undefined;
      if (cellId && commandCallId) {
        this.#wrappedWaitCallsByCallId.set(callId, { commandCallId, cellId });
        return;
      }
      if (cellId) {
        this.#pendingWrappedWaitCallsByCallId.set(callId, { cellId, rawArguments });
        return;
      }
    }

    if (
      isCodexSilentWriteStdinCall(rawName, rawArguments)
      || isCodexInternalToolCall(rawName, item.namespace)
    ) {
      this.#suppressedCallIds.add(callId);
      return;
    }

    this.ledger.inFlightRawCallIds.add(callId);
    this.startCall(callId, rawName, rawArguments);
  }

  handleCustomToolCall(item: Record<string, unknown>): void {
    const rawName = firstString(item.name, item.type);
    const callId = this.#admitCall(item);
    if (!callId) {
      return;
    }

    const rawArguments = parseRawArguments(item);
    if (rawName === 'apply_patch') {
      const input = normalizeCodexToolInput(rawName, rawArguments);
      this.ledger.rememberFileChangeInput(callId, input);
      this.deferred.deferPatch(callId, input);
      return;
    }

    if (rawName === 'exec') {
      const decodedCalls = decodeCodexExecEnvelopeCalls(rawArguments);
      const isSingleCommand = decodedCalls?.length === 1
        && decodedCalls[0]?.name === 'Bash';
      const expectedCalls = decodedCalls?.filter(call => (
        !isCodexInternalToolCall(call.rawName)
        && !isCodexSilentWriteStdinCall(call.rawName, call.rawInput)
      ));
      if (expectedCalls?.length === 0) {
        // Its output, and any yielded continuation, carries only internal values or silent polls.
        this.#withheldOutputCallIds.add(callId);
        return;
      }
      if (decodedCalls && expectedCalls && !isSingleCommand) {
        this.deferred.deferScript(callId, expectedCalls, expectedCalls.length < decodedCalls.length);
        return;
      }
    }

    this.#immediateOutputCallIds.add(callId);
    this.startCall(callId, rawName, rawArguments);
  }

  /**
   * Publishes a raw call, or refreshes its recorded identity when already published.
   * Canonical items start raw-shaped calls with `fromCanonicalProjection`.
   */
  startCall(
    callId: string,
    rawName: string,
    rawArguments: Record<string, unknown>,
    fromCanonicalProjection = false,
  ): void {
    const normalized = normalizeCodexToolCall(rawName, rawArguments);
    this.#toolNamesByCallId.set(callId, normalized.name);
    this.ledger.requestedInputs.set(callId, normalized.input);
    if (this.ledger.rawStartedIds.has(callId)) {
      return;
    }

    this.ledger.rawStartedIds.add(callId);
    if (
      normalized.name !== 'Bash'
      && !fromCanonicalProjection
      && this.ledger.canonicalStartedIds.has(callId)
    ) {
      return;
    }
    const command = normalized.name === 'Bash'
      ? firstString(normalized.input.command)
      : '';
    if (command) {
      const rawOwnsCompletion = this.#immediateOutputCallIds.has(callId);
      const paired = this.commands.correlateRawCommand({
        callId,
        rawName,
        rawArguments,
        command,
        rawOwnsCompletion,
      });
      if (paired) {
        this.deferred.release(paired.canonicalItemId);
        if (paired.streamedOutput && rawOwnsCompletion) {
          this.#wrappedCommandOutputByCallId.set(callId, paired.streamedOutput);
          this.#canonicalPrefilledCommandCallIds.add(callId);
        }
        return;
      }
    }

    this.sink.emitToolUse({
      type: 'tool_use',
      id: callId,
      name: normalized.name,
      input: normalized.input,
    });
  }

  handleOutput(item: Record<string, unknown>): void {
    const callId = readRawCallId(item);
    if (!callId) {
      return;
    }
    if (
      !this.#seenCallIds.has(callId)
      && !this.ledger.rawStartedIds.has(callId)
      && !this.deferred.has(callId)
    ) {
      this.#pendingOutputItemsByCallId.set(callId, item);
      return;
    }
    if (this.#pendingWrappedWaitCallsByCallId.has(callId)) {
      this.#pendingOutputItemsByCallId.set(callId, item);
      return;
    }
    if (this.#handledOutputCallIds.has(callId)) {
      return;
    }
    this.#handledOutputCallIds.add(callId);
    this.ledger.inFlightRawCallIds.delete(callId);

    if (this.#withheldOutputCallIds.delete(callId)) {
      this.#withholdExecCell(item.output);
      return;
    }

    const wrappedWaitCall = this.#wrappedWaitCallsByCallId.get(callId);
    if (wrappedWaitCall) {
      this.#wrappedWaitCallsByCallId.delete(callId);
      this.#handleWrappedWaitOutput(wrappedWaitCall, item.output);
      return;
    }

    if (
      this.#suppressedCallIds.delete(callId)
      || this.#ignoredLateOutputCallIds.has(callId)
      || this.ledger.emittedResultIds.has(callId)
    ) {
      return;
    }

    const deferredOutput = this.deferred.acceptRawOutput(callId, item.output);
    if (deferredOutput) {
      if (deferredOutput.withholdsRawOutput) this.#withholdExecCell(item.output);
      return;
    }

    const normalizedName = this.#toolNamesByCallId.get(callId);
    if (!normalizedName) {
      return;
    }

    const rawOutput = item.output;
    const rawOutputText = stringifyCodexToolOutput(rawOutput);
    const content = normalizeRawToolOutput(
      normalizedName,
      rawOutput,
      this.ledger.requestedInputs.get(callId),
    );
    const result = {
      content,
      isError: isCodexToolOutputError(rawOutputText),
    };

    if (this.#immediateOutputCallIds.delete(callId)) {
      const execCellId = normalizedName === 'Bash' || normalizedName === 'exec'
        ? extractCodexExecCellId(rawOutputText)
        : undefined;
      if (execCellId) {
        this.#wrappedCommandCallIdsByCellId.set(execCellId, callId);
        this.#appendWrappedCommandOutput(callId, content);
        this.#bindPendingWrappedWaitCalls(execCellId, callId);
        return;
      }

      this.#wrappedCommandOutputByCallId.delete(callId);
      this.#canonicalPrefilledCommandCallIds.delete(callId);
      if (!this.ledger.emittedResultIds.has(callId)) {
        this.ledger.emittedResultIds.add(callId);
        this.sink.emit({
          type: 'tool_result',
          id: this.commands.visibleId(callId),
          ...result,
        });
      }
      return;
    }

    this.ledger.pendingRawResults.set(callId, result);
  }

  /** Output can arrive before its call; replay it once the call is known. */
  replayPendingOutput(item: Record<string, unknown>): void {
    const callId = readRawCallId(item);
    if (!callId) {
      return;
    }
    const pendingOutput = this.#pendingOutputItemsByCallId.get(callId);
    if (!pendingOutput) {
      return;
    }
    this.#pendingOutputItemsByCallId.delete(callId);
    this.handleOutput(pendingOutput);
  }

  /** Late raw output for a call its canonical completion already settled. */
  ignoreLateOutput(callId: string): void {
    this.#ignoredLateOutputCallIds.add(callId);
  }

  /** A canonical command settled this raw call. */
  releaseCommandCall(callId: string): void {
    this.#wrappedCommandOutputByCallId.delete(callId);
    this.#canonicalPrefilledCommandCallIds.delete(callId);
    this.#ignoredLateOutputCallIds.add(callId);
  }

  /** Closes every raw lifecycle still open at turn end. */
  flush(terminalError: boolean): void {
    this.#flushPendingWrappedWaitCalls(terminalError);
    this.#flushPendingRawResults();
    this.#flushInFlightCalls(terminalError);
  }

  /** Returns the call ID of a raw call seen for the first time and not already settled canonically. */
  #admitCall(item: Record<string, unknown>): string | undefined {
    const callId = readRawCallId(item);
    if (!callId || this.#seenCallIds.has(callId)) {
      return undefined;
    }
    this.#seenCallIds.add(callId);
    if (this.ledger.canonicalCompletedIds.has(callId)) {
      this.#ignoredLateOutputCallIds.add(callId);
      return undefined;
    }
    return callId;
  }

  /** A yielded withheld script continues through `wait` calls that carry the same combined output. */
  #withholdExecCell(rawOutput: unknown): void {
    const cellId = extractCodexExecCellId(stringifyCodexToolOutput(rawOutput));
    if (cellId) this.#withheldExecCellIds.add(cellId);
  }

  #handleWrappedWaitOutput(waitCall: WrappedWaitCall, rawOutput: unknown): void {
    const rawOutputText = stringifyCodexToolOutput(rawOutput);
    const content = normalizeRawToolOutput(
      this.#toolNamesByCallId.get(waitCall.commandCallId) ?? 'Bash',
      rawOutput,
      this.ledger.requestedInputs.get(waitCall.commandCallId),
    );
    const nextCellId = extractCodexExecCellId(rawOutputText);

    if (nextCellId) {
      this.#wrappedCommandCallIdsByCellId.delete(waitCall.cellId);
      this.#wrappedCommandCallIdsByCellId.set(nextCellId, waitCall.commandCallId);
      this.#appendWrappedCommandOutput(waitCall.commandCallId, content);
      return;
    }

    const previousOutput = this.#wrappedCommandOutputByCallId.get(waitCall.commandCallId);
    const completeOutput = appendCodexCommandOutput(previousOutput, content);
    this.#wrappedCommandOutputByCallId.delete(waitCall.commandCallId);
    this.#canonicalPrefilledCommandCallIds.delete(waitCall.commandCallId);
    this.#wrappedCommandCallIdsByCellId.delete(waitCall.cellId);
    this.ledger.emittedResultIds.add(waitCall.commandCallId);
    this.sink.emit({
      type: 'tool_result',
      id: this.commands.visibleId(waitCall.commandCallId),
      content: completeOutput,
      isError: isCodexToolOutputError(rawOutputText),
    });
  }

  #bindPendingWrappedWaitCalls(cellId: string, commandCallId: string): void {
    for (const [waitCallId, waitCall] of this.#pendingWrappedWaitCallsByCallId) {
      if (waitCall.cellId !== cellId) {
        continue;
      }
      this.#pendingWrappedWaitCallsByCallId.delete(waitCallId);
      this.#wrappedWaitCallsByCallId.set(waitCallId, { commandCallId, cellId });
      const pendingOutput = this.#pendingOutputItemsByCallId.get(waitCallId);
      if (pendingOutput) {
        this.#pendingOutputItemsByCallId.delete(waitCallId);
        this.handleOutput(pendingOutput);
      }
    }
  }

  #appendWrappedCommandOutput(callId: string, content: string): void {
    if (!content) return;

    const previousOutput = this.#wrappedCommandOutputByCallId.get(callId);
    const completeOutput = this.#canonicalPrefilledCommandCallIds.delete(callId)
      ? mergeOverlappingCommandOutput(previousOutput, content)
      : appendCodexCommandOutput(previousOutput, content);
    const delta = completeOutput.slice(previousOutput?.length ?? 0);
    this.#wrappedCommandOutputByCallId.set(callId, completeOutput);
    if (delta) {
      this.sink.emit({ type: 'tool_output', id: this.commands.visibleId(callId), content: delta });
    }
  }

  #flushPendingWrappedWaitCalls(terminalError: boolean): void {
    for (const [callId, waitCall] of this.#pendingWrappedWaitCallsByCallId) {
      this.#pendingWrappedWaitCallsByCallId.delete(callId);
      this.startCall(callId, 'wait', waitCall.rawArguments);
      const pendingOutput = this.#pendingOutputItemsByCallId.get(callId);
      if (pendingOutput) {
        this.#pendingOutputItemsByCallId.delete(callId);
        this.handleOutput(pendingOutput);
      } else {
        this.ledger.emittedResultIds.add(callId);
        this.sink.emit({ type: 'tool_result', id: callId, content: '', isError: terminalError });
      }
    }
  }

  #flushPendingRawResults(): void {
    for (const [callId, result] of this.ledger.pendingRawResults) {
      this.sink.emit({ type: 'tool_result', id: this.commands.visibleId(callId), ...result });
    }
    this.ledger.pendingRawResults.clear();
  }

  #flushInFlightCalls(isError: boolean): void {
    const yieldedCommandCallIds = new Set(this.#wrappedCommandCallIdsByCellId.values());
    const closeCall = (callId: string, content: string) => {
      if (this.ledger.emittedResultIds.has(callId)) {
        return;
      }
      this.ledger.emittedResultIds.add(callId);
      this.sink.emit({ type: 'tool_result', id: this.commands.visibleId(callId), content, isError });
    };
    for (const callId of yieldedCommandCallIds) {
      closeCall(callId, this.#wrappedCommandOutputByCallId.get(callId) ?? '');
    }
    for (const callId of this.#immediateOutputCallIds) {
      closeCall(callId, '');
    }
    for (const callId of this.ledger.inFlightRawCallIds) {
      closeCall(callId, '');
    }
    this.#wrappedCommandCallIdsByCellId.clear();
    this.#wrappedCommandOutputByCallId.clear();
    this.#wrappedWaitCallsByCallId.clear();
    this.#withheldExecCellIds.clear();
    this.#withheldOutputCallIds.clear();
    this.#pendingWrappedWaitCallsByCallId.clear();
    this.ledger.inFlightRawCallIds.clear();
    this.#immediateOutputCallIds.clear();
  }
}

function readRawCallId(item: Record<string, unknown>): string {
  return firstString(item.call_id, item.id);
}

function parseRawArguments(item: Record<string, unknown>): Record<string, unknown> {
  const rawArgs = typeof item.arguments === 'string'
    ? item.arguments
    : typeof item.input === 'string'
      ? item.input
      : undefined;
  return parseCodexArguments(rawArgs);
}

/** Canonical output that streamed before pairing can overlap the raw output that repeats it. */
function mergeOverlappingCommandOutput(previous: string | undefined, next: string): string {
  if (!previous || !next) {
    return previous || next;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.endsWith(next)) {
    return previous;
  }
  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.endsWith(next.slice(0, overlap))) {
      return previous + next.slice(overlap);
    }
  }
  return appendCodexCommandOutput(previous, next);
}
