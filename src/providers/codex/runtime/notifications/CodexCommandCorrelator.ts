import * as path from 'path';

import { decodeCodexExecEnvelopeCalls } from '@/providers/codex/normalization/codexToolNormalization';
import type { CommandExecutionItem } from '@/providers/codex/runtime/codexAppServerTypes';

import {
  normalizeWorkingDirectory,
  projectCommandToolResult,
  readCanonicalCommand,
  readCanonicalCommandCandidates,
} from './codexItemToolProjection';
import { firstString } from './codexNotificationValues';
import type { CodexToolChunkSink, CodexToolLedger } from './CodexToolLedger';

export interface RawCommandProjection {
  callId: string;
  visibleId: string;
  command: string;
  workingDirectory?: string;
  rawOwnsCompletion: boolean;
}

interface CanonicalCommandProjection {
  itemId: string;
  commands: string[];
  workingDirectory?: string;
}

export interface RawCommandCall {
  callId: string;
  rawName: string;
  rawArguments: Record<string, unknown>;
  command: string;
  rawOwnsCompletion: boolean;
}

/**
 * Pairs raw command calls with canonical command items and buffers canonical tool output.
 *
 * Raw tool calls and canonical command items describe the same work with unrelated IDs.
 * A uniquely correlated command keeps whichever projection started first as the visible row.
 */
export class CodexCommandCorrelator {
  #unmatchedRawCommands: RawCommandProjection[] = [];
  #unmatchedCanonicalCommands: CanonicalCommandProjection[] = [];
  #rawCommandByCanonicalId = new Map<string, RawCommandProjection>();
  #canonicalCommandOutputByItemId = new Map<string, string>();
  #pendingCanonicalToolOutputByItemId = new Map<string, string[]>();

  constructor(
    private readonly sink: CodexToolChunkSink,
    private readonly ledger: CodexToolLedger,
    /** Retires the raw lifecycle of a call once its canonical command settles it. */
    private readonly releaseRawCall: (callId: string) => void,
    private readonly workingDirectory?: string,
  ) {}

  reset(): void {
    this.#unmatchedRawCommands.length = 0;
    this.#unmatchedCanonicalCommands.length = 0;
    this.#rawCommandByCanonicalId.clear();
    this.#canonicalCommandOutputByItemId.clear();
    this.#pendingCanonicalToolOutputByItemId.clear();
  }

  trackCanonicalCommand(item: CommandExecutionItem): void {
    this.#unmatchedCanonicalCommands.push({
      itemId: item.id,
      commands: readCanonicalCommandCandidates(item),
      workingDirectory: normalizeWorkingDirectory(item.cwd, this.workingDirectory),
    });
  }

  /** A deferred script call now owns this canonical item. */
  dropUnmatchedCanonical(itemId: string): void {
    const index = this.#unmatchedCanonicalCommands.findIndex(command => command.itemId === itemId);
    if (index !== -1) {
      this.#unmatchedCanonicalCommands.splice(index, 1);
    }
  }

  /**
   * Pairs a raw command with a unique started canonical command, or records it for a later one.
   * Returns the paired canonical item and the output it streamed before the pairing.
   */
  correlateRawCommand(call: RawCommandCall): { canonicalItemId: string; streamedOutput?: string } | undefined {
    const workingDirectory = this.#readRawCommandWorkingDirectory(call.rawName, call.rawArguments);
    const canonicalCommand = this.#takeUniqueCanonicalCommand(call.command, workingDirectory);
    const projection: RawCommandProjection = {
      callId: call.callId,
      visibleId: canonicalCommand?.itemId ?? call.callId,
      command: call.command,
      workingDirectory,
      rawOwnsCompletion: call.rawOwnsCompletion,
    };
    if (!canonicalCommand) {
      this.#unmatchedRawCommands.push(projection);
      return undefined;
    }

    this.#rawCommandByCanonicalId.set(canonicalCommand.itemId, projection);
    const streamedOutput = this.#canonicalCommandOutputByItemId.get(canonicalCommand.itemId);
    this.#canonicalCommandOutputByItemId.delete(canonicalCommand.itemId);
    return { canonicalItemId: canonicalCommand.itemId, streamedOutput };
  }

  claimPendingRawCommand(item: CommandExecutionItem): RawCommandProjection | undefined {
    const rawAction = readCanonicalCommand(item);
    const workingDirectory = normalizeWorkingDirectory(item.cwd, this.workingDirectory);
    let index = this.#unmatchedRawCommands.findIndex(command => command.callId === item.id);
    if (index === -1) {
      const matchingIndexes = this.#unmatchedRawCommands
        .map((command, candidateIndex) => ({ command, candidateIndex }))
        .filter(({ command }) => (
          (command.command === rawAction || command.command === item.command)
          && command.workingDirectory === workingDirectory
        ));
      if (matchingIndexes.length === 1) {
        index = matchingIndexes[0]?.candidateIndex ?? -1;
      }
    }
    if (index === -1) {
      return undefined;
    }

    const [command] = this.#unmatchedRawCommands.splice(index, 1);
    if (!command) {
      return undefined;
    }
    this.#rawCommandByCanonicalId.set(item.id, command);
    return command;
  }

  resolveCompletedRawCommand(item: CommandExecutionItem): RawCommandProjection | undefined {
    return this.#rawCommandByCanonicalId.get(item.id) ?? this.claimPendingRawCommand(item);
  }

  /** The row a raw call is shown as: its paired canonical item when the canonical started first. */
  visibleId(callId: string): string {
    for (const projection of this.#rawCommandByCanonicalId.values()) {
      if (projection.callId === callId) {
        return projection.visibleId;
      }
    }
    return callId;
  }

  complete(item: CommandExecutionItem, resolvedRawCommand?: RawCommandProjection): void {
    const rawCommand = resolvedRawCommand ?? this.#rawCommandByCanonicalId.get(item.id);
    this.dropUnmatchedCanonical(item.id);
    if (rawCommand?.rawOwnsCompletion) {
      return;
    }

    const rawResult = this.ledger.consumeRawResult(rawCommand?.callId ?? item.id);
    this.sink.emit({
      type: 'tool_result',
      id: rawCommand?.visibleId ?? item.id,
      ...projectCommandToolResult(item, rawResult),
    });
    this.#canonicalCommandOutputByItemId.delete(item.id);
    if (rawCommand) {
      this.releaseRawCall(rawCommand.callId);
    }
  }

  handleOutputDelta(params: { itemId: string; delta: string }, isCommandOutput: boolean): void {
    const rawCommand = this.#rawCommandByCanonicalId.get(params.itemId);
    if (rawCommand?.rawOwnsCompletion) {
      return;
    }
    if (isCommandOutput) {
      const previousOutput = this.#canonicalCommandOutputByItemId.get(params.itemId) ?? '';
      this.#canonicalCommandOutputByItemId.set(params.itemId, previousOutput + params.delta);
    }
    const lifecycleStarted = this.ledger.canonicalStartedIds.has(params.itemId)
      || this.ledger.rawStartedIds.has(params.itemId)
      || rawCommand !== undefined;
    if (!lifecycleStarted) {
      const pendingOutput = this.#pendingCanonicalToolOutputByItemId.get(params.itemId) ?? [];
      pendingOutput.push(params.delta);
      this.#pendingCanonicalToolOutputByItemId.set(params.itemId, pendingOutput);
      return;
    }
    this.sink.emit({
      type: 'tool_output',
      id: rawCommand?.visibleId ?? params.itemId,
      content: params.delta,
    });
  }

  /** Publishes output that streamed before the item's lifecycle started. */
  flushPendingOutput(itemId: string): void {
    const pendingOutput = this.#pendingCanonicalToolOutputByItemId.get(itemId);
    if (!pendingOutput) {
      return;
    }
    this.#pendingCanonicalToolOutputByItemId.delete(itemId);
    const rawCommand = this.#rawCommandByCanonicalId.get(itemId);
    if (rawCommand?.rawOwnsCompletion) {
      return;
    }
    for (const content of pendingOutput) {
      this.sink.emit({
        type: 'tool_output',
        id: rawCommand?.visibleId ?? itemId,
        content,
      });
    }
  }

  #takeUniqueCanonicalCommand(
    command: string,
    workingDirectory?: string,
  ): CanonicalCommandProjection | undefined {
    const matches = this.#unmatchedCanonicalCommands
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => (
        candidate.commands.includes(command)
        && candidate.workingDirectory === workingDirectory
      ));
    if (matches.length !== 1) {
      return undefined;
    }

    const match = matches[0];
    if (!match) {
      return undefined;
    }
    this.#unmatchedCanonicalCommands.splice(match.index, 1);
    return match.candidate;
  }

  #readRawCommandWorkingDirectory(
    rawName: string,
    rawArguments: Record<string, unknown>,
  ): string | undefined {
    let commandInput = rawArguments;
    if (rawName === 'exec') {
      const calls = decodeCodexExecEnvelopeCalls(rawArguments);
      const commandCall = calls?.length === 1 && calls[0]?.name === 'Bash'
        ? calls[0]
        : undefined;
      commandInput = commandCall?.rawInput ?? {};
    }

    const rawWorkingDirectory = firstString(
      commandInput.workdir,
      commandInput.cwd,
      commandInput.workingDirectory,
    );
    if (rawWorkingDirectory) {
      return this.workingDirectory
        ? path.resolve(this.workingDirectory, rawWorkingDirectory)
        : normalizeWorkingDirectory(rawWorkingDirectory);
    }
    return normalizeWorkingDirectory(this.workingDirectory);
  }
}
