import * as path from 'path';

import {
  codexToolRequestsMatch,
  type DecodedCodexExecEnvelopeCall,
  isCodexToolOutputError,
  stableValueKey,
  stringifyCodexToolOutput,
} from '@/providers/codex/normalization/codexToolNormalization';

import {
  type CanonicalToolProjection,
  normalizeRawToolOutput,
  resolveToolWorkingDirectory,
} from './codexItemToolProjection';
import { asRecord, firstString } from './codexNotificationValues';
import type { CodexToolChunkSink, CodexToolLedger } from './CodexToolLedger';

interface ExpectedCall {
  name: string;
  input: Record<string, unknown>;
  comparisonInput?: Record<string, unknown>;
  claimed: boolean;
  canonicalItemId?: string;
  canonicalCompleted?: boolean;
  fallbackId?: string;
}

interface DeferredRawExecCall {
  callId: string;
  expectedCalls: ExpectedCall[];
  hasRawOutput?: boolean;
  rawOutput?: unknown;
  /** The unsplit script output also contains hidden internal calls' values. */
  withholdsRawOutput?: boolean;
}

export interface CodexDeferredExecOptions {
  workingDirectory?: string;
  /** Child streams publish script calls immediately and let canonical items refine them. */
  streamRawExecCalls: boolean;
  /** A deferred script call now owns this canonical item. */
  onCanonicalClaimed(itemId: string): void;
  /** A canonical web search performs this requested search. */
  onWebSearchClaimed(itemId: string, requestedInput: Record<string, unknown>): void;
}

/**
 * Correlates non-Bash Code Mode script calls with the canonical items that perform them.
 *
 * Script calls are transport envelopes. Canonical items own their semantic lifecycles;
 * the envelope remains available as a lossless raw-only fallback when no item claims a call.
 */
export class CodexDeferredExecCorrelator {
  #deferredCalls = new Map<string, DeferredRawExecCall>();
  #projectedItemIds = new Set<string>();
  #activeProjections = new Map<string, CanonicalToolProjection>();
  #ownedItemIds = new Set<string>();
  /** Canonical IDs published under a streamed fallback ID. */
  #aliases = new Map<string, string>();

  constructor(
    private readonly sink: CodexToolChunkSink,
    private readonly ledger: CodexToolLedger,
    private readonly options: CodexDeferredExecOptions,
  ) {}

  reset(): void {
    this.#deferredCalls.clear();
    this.#projectedItemIds.clear();
    this.#activeProjections.clear();
    this.#ownedItemIds.clear();
    this.#aliases.clear();
  }

  aliasFor(id: string): string | undefined {
    return this.#aliases.get(id);
  }

  has(callId: string): boolean {
    return this.#deferredCalls.has(callId);
  }

  deferPatch(callId: string, input: Record<string, unknown>): void {
    this.#deferredCalls.set(callId, {
      callId,
      expectedCalls: [{ name: 'apply_patch', input, claimed: false }],
    });
    this.#claimActiveProjections();
  }

  deferScript(callId: string, calls: DecodedCodexExecEnvelopeCall[], withholdsRawOutput: boolean): void {
    const deferredExec: DeferredRawExecCall = {
      callId,
      withholdsRawOutput,
      expectedCalls: calls.map(call => ({
        ...projectRawSemanticToolCall(call, this.options.workingDirectory),
        claimed: false,
      })),
    };
    this.#deferredCalls.set(callId, deferredExec);
    this.#claimActiveProjections();
    if (this.options.streamRawExecCalls && this.#deferredCalls.has(callId)) {
      this.#emitFallback(deferredExec);
    }
  }

  /** Records a deferred script's output; returns null when the call is not deferred. */
  acceptRawOutput(callId: string, rawOutput: unknown): { withholdsRawOutput: boolean } | null {
    const deferredExec = this.#deferredCalls.get(callId);
    if (!deferredExec) {
      return null;
    }
    deferredExec.hasRawOutput = true;
    deferredExec.rawOutput = rawOutput;
    if (this.options.streamRawExecCalls) this.#emitFallback(deferredExec, rawOutput, true);
    this.#deleteIfSettled(deferredExec);
    return { withholdsRawOutput: Boolean(deferredExec.withholdsRawOutput) };
  }

  /** Returns whether a deferred script call owns this canonical item. */
  claimItem(projection: CanonicalToolProjection, completed: boolean): boolean {
    const claimed = this.#registerProjection(projection, completed);
    if (claimed) {
      this.#ownedItemIds.add(projection.itemId);
    }
    return claimed || this.#ownedItemIds.has(projection.itemId);
  }

  /** A raw command paired directly with this canonical item. */
  release(itemId: string): void {
    this.#activeProjections.delete(itemId);
  }

  claimPlanUpdate(itemId: string, requestInput: Record<string, unknown>): void {
    this.#claim('TodoWrite', requestInput, requestInput, itemId, true);
  }

  markCanonicalCompleted(itemId: string): void {
    for (const deferredExec of this.#deferredCalls.values()) {
      const claimedCall = deferredExec.expectedCalls.find(call => (
        call.canonicalItemId === itemId
      ));
      if (claimedCall) {
        claimedCall.canonicalCompleted = true;
        this.#deleteIfSettled(deferredExec);
        return;
      }
    }
  }

  /** Publish unresolved calls before later assistant content can overtake them. */
  publishPending(completedOnly = false): void {
    for (const deferredExec of this.#deferredCalls.values()) {
      if (completedOnly && !deferredExec.hasRawOutput) continue;
      this.#emitFallback(deferredExec, deferredExec.rawOutput, Boolean(deferredExec.hasRawOutput));
    }
  }

  /** Closes every deferred call at turn end, falling back to raw cards for unclaimed calls. */
  flush(terminalError: boolean): void {
    for (const deferredExec of this.#deferredCalls.values()) {
      this.#emitFallback(deferredExec, deferredExec.rawOutput, true, terminalError, true);
    }
    this.#deferredCalls.clear();
  }

  #deleteIfSettled(deferredExec: DeferredRawExecCall): void {
    if (
      deferredExec.hasRawOutput
      && deferredExec.expectedCalls.every(call => call.claimed && call.canonicalCompleted)
    ) {
      this.#deferredCalls.delete(deferredExec.callId);
    }
  }

  #emitFallback(
    deferredExec: DeferredRawExecCall,
    rawOutput?: unknown,
    emitResult = false,
    terminalError = false,
    turnEnded = false,
  ): void {
    const rawOutputText = stringifyCodexToolOutput(rawOutput);
    const resultFor = (call: ExpectedCall) => ({
      content: deferredExec.withholdsRawOutput ? '' : normalizeRawToolOutput(call.name, rawOutput, call.input),
      isError: isCodexToolOutputError(rawOutputText)
        || (terminalError && !deferredExec.hasRawOutput),
    });
    deferredExec.expectedCalls.forEach((call, index) => {
      if (call.claimed) {
        // Native completion carries search sources and withheld command output;
        // script output closes those only when the turn ends.
        if (emitResult && !call.canonicalCompleted && call.canonicalItemId
          && (turnEnded || (this.options.streamRawExecCalls && call.name !== 'WebSearch' && !deferredExec.withholdsRawOutput))) {
          this.ledger.canonicalCompletedIds.add(call.canonicalItemId);
          this.sink.emit({ type: 'tool_result', id: call.canonicalItemId, ...resultFor(call) });
          call.canonicalCompleted = true;
        }
        return;
      }
      const fallbackId = deferredExec.expectedCalls.length === 1
        ? deferredExec.callId
        : `${deferredExec.callId}:${index + 1}`;
      if (!call.fallbackId) {
        this.sink.emitToolUse({ type: 'tool_use', id: fallbackId, name: call.name, input: call.input });
        call.fallbackId = fallbackId;
      }
      if (emitResult && !this.ledger.emittedResultIds.has(fallbackId)) {
        this.ledger.emittedResultIds.add(fallbackId);
        this.sink.emit({ type: 'tool_result', id: fallbackId, ...resultFor(call) });
      }
    });
  }

  #registerProjection(projection: CanonicalToolProjection, completed: boolean): boolean {
    if (this.#projectedItemIds.has(projection.itemId)) {
      if (!this.#activeProjections.has(projection.itemId)) {
        return false;
      }
      if (this.#claim(
        projection.name,
        projection.input,
        projection.comparisonInput,
        projection.itemId,
        completed,
      )) {
        this.#activeProjections.delete(projection.itemId);
        return true;
      }
      this.#activeProjections.set(projection.itemId, projection);
      return false;
    }
    this.#projectedItemIds.add(projection.itemId);
    const claimed = this.#claim(
      projection.name,
      projection.input,
      projection.comparisonInput,
      projection.itemId,
      completed,
    );
    if (!claimed) {
      this.#activeProjections.set(projection.itemId, projection);
    }
    return claimed;
  }

  /** A new script call can perform canonical items that started before it. */
  #claimActiveProjections(): void {
    for (const [itemId, projection] of this.#activeProjections) {
      const completed = this.ledger.canonicalCompletedIds.has(itemId);
      if (this.#claim(
        projection.name,
        projection.input,
        projection.comparisonInput,
        itemId,
        completed,
        completed,
      )) {
        this.#activeProjections.delete(itemId);
        this.#ownedItemIds.add(itemId);
        this.options.onCanonicalClaimed(itemId);
      }
    }
  }

  #claim(
    name: string,
    input: Record<string, unknown>,
    comparisonInput = input,
    canonicalItemId?: string,
    canonicalCompleted = false,
    requireSameId = false,
  ): boolean {
    const projectedName = semanticToolName(name);
    const availableCalls = [...this.#deferredCalls.values()].flatMap(deferredExec => (
      deferredExec.expectedCalls
        .filter(call => !call.claimed && call.name === projectedName)
        .map(expectedCall => ({ deferredExec, expectedCall }))
    ));
    const sameIdCalls = canonicalItemId
      ? availableCalls.filter(({ deferredExec }) => deferredExec.callId === canonicalItemId)
      : [];
    const compatibleCalls = (
      sameIdCalls.length > 0
        ? sameIdCalls
        : requireSameId
          ? []
          : availableCalls
    )
      .filter(({ expectedCall }) => toolInputsCompatible(
        projectedName,
        expectedCall.comparisonInput ?? expectedCall.input,
        comparisonInput,
        this.options.workingDirectory,
      ));
    const match = sameIdCalls.length === 1
      ? sameIdCalls[0]
      : compatibleCalls.length === 1
        ? compatibleCalls[0]
        : undefined;
    if (!match) {
      return false;
    }

    const { deferredExec, expectedCall } = match;
    // Native web actions abbreviate the request ("first query ...", openPage, other); keep the requested one.
    if (projectedName === 'WebSearch' && canonicalItemId) {
      this.options.onWebSearchClaimed(canonicalItemId, expectedCall.input);
    }
    if (expectedCall.fallbackId && canonicalItemId) this.#aliases.set(canonicalItemId, expectedCall.fallbackId);
    expectedCall.claimed = true;
    expectedCall.canonicalItemId = canonicalItemId;
    expectedCall.canonicalCompleted = canonicalCompleted;
    this.#deleteIfSettled(deferredExec);
    return true;
  }
}

function semanticToolName(name: string): string {
  switch (name) {
    case 'web__run':
      return 'WebSearch';
    case 'wait_agent':
      return 'wait';
    default:
      return name;
  }
}

function projectRawSemanticToolCall(
  call: DecodedCodexExecEnvelopeCall,
  workingDirectory?: string,
): Pick<ExpectedCall, 'name' | 'input' | 'comparisonInput'> {
  const { name, input, rawName, rawInput } = call;
  if (rawName === 'update_plan') {
    const explanation = firstString(rawInput.explanation);
    return {
      name: 'TodoWrite',
      input: {
        ...input,
        ...(explanation ? { explanation } : {}),
      },
    };
  }
  if (name === 'Bash') {
    return {
      name,
      input,
      comparisonInput: {
        ...input,
        workingDirectory: resolveToolWorkingDirectory(
          firstString(
            rawInput.workdir,
            rawInput.cwd,
            rawInput.workingDirectory,
          ),
          workingDirectory,
        ),
      },
    };
  }
  return { name: semanticToolName(name), input };
}

function toolInputsCompatible(
  name: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  workingDirectory?: string,
): boolean {
  if (name === 'apply_patch') {
    const expectedChanges = extractRawPatchChanges(expected.patch, workingDirectory);
    const actualChanges = extractCanonicalFileChanges(actual.changes, workingDirectory);
    if (expectedChanges.length > 0 || actualChanges.length > 0) {
      return expectedChanges.length === actualChanges.length && expectedChanges.every((expectedChange, index) => {
        const actualChange = actualChanges[index];
        if (expectedChange.path !== actualChange.path || expectedChange.kind !== actualChange.kind
          || expectedChange.movePath !== actualChange.movePath) return false;
        if (expectedChange.kind !== 'update') return stableValueKey(expectedChange.lines) === stableValueKey(actualChange.lines);
        // Native update diffs can include more context than the requested patch.
        // Require every edit and the supplied context; ambiguous concurrent calls
        // are still rejected by the unique-candidate check in #claim.
        const edits = (lines: string[]) => lines.filter(line => line.startsWith('+') || line.startsWith('-'));
        if (stableValueKey(edits(expectedChange.lines)) !== stableValueKey(edits(actualChange.lines))) return false;
        return expectedChange.lines.length > 0 && actualChange.lines.some((_, start) => expectedChange.lines.every((line, offset) => actualChange.lines[start + offset] === line));
      });
    }
  }

  return codexToolRequestsMatch(name, expected, actual);
}

// -- apply_patch comparison ---------------------------------------------------

interface ComparedFileChange {
  path: string;
  kind: string;
  movePath?: string;
  lines: string[];
}

function extractRawPatchChanges(
  value: unknown,
  workingDirectory?: string,
): ComparedFileChange[] {
  if (typeof value !== 'string') {
    return [];
  }
  const changes: ComparedFileChange[] = [];
  let current: ComparedFileChange | undefined;
  for (const line of value.split('\n')) {
    const match = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (match?.[1] && match[2]) {
      if (current) {
        changes.push(current);
      }
      current = {
        path: normalizeComparedFilePath(match[2], workingDirectory),
        kind: normalizeComparedChangeKind(match[1]),
        lines: [],
      };
      continue;
    }
    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
    if (current && moveMatch?.[1]) {
      current.movePath = normalizeComparedFilePath(moveMatch[1], workingDirectory);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('@@')) {
      const anchor = extractRawPatchHunkAnchor(line);
      if (anchor) {
        current.lines.push(`@${anchor}`);
      }
    } else if (line.startsWith('+') || line.startsWith('-')) {
      current.lines.push(line);
    } else if (line.startsWith(' ')) {
      current.lines.push(line);
    }
  }
  if (current) {
    changes.push(current);
  }
  return changes.sort(compareFileChanges);
}

function extractCanonicalFileChanges(
  value: unknown,
  workingDirectory?: string,
): ComparedFileChange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((change): ComparedFileChange | null => {
      const record = asRecord(change);
      const changePath = normalizeComparedFilePath(
        firstString(record?.path),
        workingDirectory,
      );
      if (!record || !changePath) {
        return null;
      }
      const lines: string[] = [];
      let inHunk = false;
      for (const line of firstString(record.diff).split('\n')) {
        if (line.startsWith('@@')) {
          inHunk = true;
          const anchor = extractCanonicalDiffHunkAnchor(line);
          if (anchor) {
            lines.push(`@${anchor}`);
          }
          continue;
        }
        if (
          !inHunk && (line.startsWith('+++ ') || line.startsWith('--- '))
        ) {
          continue;
        }
        if (line.startsWith('+') || line.startsWith('-')) {
          lines.push(line);
        } else if (line.startsWith(' ')) {
          lines.push(line);
        }
      }
      const movePath = firstString(record.movePath);
      return {
        path: changePath,
        kind: movePath
          ? 'update'
          : normalizeComparedChangeKind(firstString(record.kind, record.type)),
        ...(movePath
          ? {
              movePath: normalizeComparedFilePath(
                movePath,
                workingDirectory,
              ),
            }
          : {}),
        lines: normalizeComparedChangeKind(firstString(record.kind, record.type)) === 'delete' ? [] : lines,
      };
    })
    .filter((change): change is ComparedFileChange => change !== null)
    .sort(compareFileChanges);
}

function extractRawPatchHunkAnchor(line: string): string {
  return line.slice(2).trim().replace(/\s*@@$/, '').trim();
}

function extractCanonicalDiffHunkAnchor(line: string): string {
  const closingMarker = line.indexOf('@@', 2);
  return closingMarker === -1 ? '' : line.slice(closingMarker + 2).trim();
}

function normalizeComparedChangeKind(kind: string): string {
  switch (kind.toLowerCase()) {
    case 'add':
    case 'create':
      return 'add';
    case 'delete':
    case 'remove':
      return 'delete';
    case 'modify':
    case 'change':
    case 'update':
      return 'update';
    default:
      return kind.toLowerCase();
  }
}

function compareFileChanges(first: ComparedFileChange, second: ComparedFileChange): number {
  return first.path.localeCompare(second.path) || first.kind.localeCompare(second.kind);
}

function normalizeComparedFilePath(filePath: string, workingDirectory?: string): string {
  const trimmedPath = filePath.trim();
  if (!trimmedPath) {
    return '';
  }
  return workingDirectory
    ? path.resolve(workingDirectory, trimmedPath)
    : path.normalize(trimmedPath);
}
