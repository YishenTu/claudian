import type { Conversation } from '../../../core/types';
import type { ForkSource } from '../../../core/types/chat';

export interface CodexPendingForkTarget {
  threadId: string;
  sessionFilePath?: string;
}

/**
 * Native locators of a thread whose binding was invalidated. History-only: hydration
 * replays them before the live thread, but nothing may resume, fork, or recover models from them.
 */
export interface CodexPreviousSegment {
  threadId?: string;
  sessionFilePath?: string;
  transcriptRootPath?: string;
  forkSource?: ForkSource;
  forkSourceSessionFilePath?: string;
  forkSourceTranscriptRootPath?: string;
}

export interface CodexProviderState {
  threadId?: string;
  nativeConversationContextEstablished?: boolean;
  sessionFilePath?: string;
  transcriptRootPath?: string;
  forkSourceSessionFilePath?: string;
  forkSourceTranscriptRootPath?: string;
  forkSource?: ForkSource;
  pendingForkTarget?: CodexPendingForkTarget;
  workspaceDependencyToolVersion?: number;
  /** Absent on threads created before session dynamic tools were exposed. */
  sessionToolVersion?: number;
  /** Invalidated segments, oldest first. */
  previousSegments?: CodexPreviousSegment[];
}

export function getCodexState(
  providerState?: Record<string, unknown>,
): CodexProviderState {
  return (providerState ?? {});
}

const LIVE_BINDING_KEYS = [
  'threadId',
  'sessionFilePath',
  'transcriptRootPath',
  'forkSource',
  'forkSourceSessionFilePath',
  'forkSourceTranscriptRootPath',
  'pendingForkTarget',
  'sessionToolVersion',
  'workspaceDependencyToolVersion',
] as const satisfies ReadonlyArray<keyof CodexProviderState>;

const ROLLOUT_THREAD_ID_PATTERN = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Codex names rollouts `rollout-<timestamp>-<thread id>.jsonl`. */
function readRolloutThreadId(sessionFilePath: string | undefined): string | undefined {
  return sessionFilePath?.match(ROLLOUT_THREAD_ID_PATTERN)?.[1];
}

function isPendingForkSegmentOf(pending: CodexPreviousSegment, child: CodexPreviousSegment): boolean {
  return !pending.threadId
    && !!pending.forkSource
    && pending.forkSource.sessionId === child.forkSource?.sessionId
    && pending.forkSource.resumeAt === child.forkSource?.resumeAt;
}

function isSameSegment(left: CodexPreviousSegment, right: CodexPreviousSegment): boolean {
  return left.threadId === right.threadId
    && left.sessionFilePath === right.sessionFilePath
    && left.forkSource?.sessionId === right.forkSource?.sessionId
    && left.forkSource?.resumeAt === right.forkSource?.resumeAt
    && left.forkSourceSessionFilePath === right.forkSourceSessionFilePath;
}

/**
 * Ends the conversation's native binding without losing its history: the current segment
 * becomes a history-only previous segment, and the next send replays Claudian history into
 * a fresh thread. Returns whether there was a binding to clear.
 */
export function clearCodexResumeState(
  conversation: Pick<Conversation, 'sessionId' | 'providerState'>,
): boolean {
  const state = getCodexState(conversation.providerState);
  const sessionFilePath = state.sessionFilePath ?? state.pendingForkTarget?.sessionFilePath;
  const threadId = state.threadId
    ?? state.pendingForkTarget?.threadId
    ?? conversation.sessionId
    // An unbound transcript keeps its native id so archived-root lookup and archiving can find it.
    ?? (state.forkSource ? undefined : readRolloutThreadId(sessionFilePath));
  if (!threadId && !sessionFilePath && !state.forkSource) {
    return false;
  }

  const segment: CodexPreviousSegment = {
    ...(threadId ? { threadId } : {}),
    ...(sessionFilePath ? { sessionFilePath } : {}),
    ...(state.transcriptRootPath ? { transcriptRootPath: state.transcriptRootPath } : {}),
    ...(state.forkSource ? { forkSource: { ...state.forkSource } } : {}),
    ...(state.forkSource && state.forkSourceSessionFilePath
      ? { forkSourceSessionFilePath: state.forkSourceSessionFilePath }
      : {}),
    ...(state.forkSource && state.forkSourceTranscriptRootPath
      ? { forkSourceTranscriptRootPath: state.forkSourceTranscriptRootPath }
      : {}),
  };
  // A native thread is one segment: its newest state replaces earlier records of the same thread,
  // and a materialized fork child replaces the pending segment that showed its source prefix.
  const supersedes = (previous: CodexPreviousSegment) => !!segment.threadId && (
    previous.threadId === segment.threadId || isPendingForkSegmentOf(previous, segment)
  );
  const previousSegments: CodexPreviousSegment[] = [];
  let placed = false;
  for (const previous of state.previousSegments ?? []) {
    if (!supersedes(previous)) {
      previousSegments.push({ ...previous });
    } else if (!placed) {
      previousSegments.push(segment);
      placed = true;
    }
  }
  if (!placed && !previousSegments.some(previous => isSameSegment(previous, segment))) {
    previousSegments.push(segment);
  }

  const providerState: Record<string, unknown> = { ...(conversation.providerState ?? {}) };
  for (const key of LIVE_BINDING_KEYS) delete providerState[key];
  providerState.nativeConversationContextEstablished = false;
  providerState.previousSegments = previousSegments;
  conversation.sessionId = null;
  conversation.providerState = providerState;
  return true;
}
