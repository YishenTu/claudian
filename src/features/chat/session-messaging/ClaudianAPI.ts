import type { SessionToolSendStatus } from '@/core/session-tools/sessionToolSpecs';
import type { AskUserAnswers } from '@/core/types';
import type { PendingInteractionSnapshot } from '@/features/chat/interactions/SessionInteractions';
import type {
  ClientSendOptions,
  ClientSessionList,
  SessionMessagingService,
} from '@/features/chat/session-messaging/SessionMessagingService';
import type { SessionSignal } from '@/features/chat/sessions/ChatSessionRuntime';
import type { ResponseProgress } from '@/features/chat/state/types';

/** Workspace event fired with `ClaudianTurnEndedEvent` when a session finishes its turn and any work it left running. */
export const CLAUDIAN_TURN_ENDED_EVENT = 'claudian:turn-ended';
/** Workspace event fired with `ClaudianTurnProgressEvent` for every streamed block change, as received. */
export const CLAUDIAN_TURN_PROGRESS_EVENT = 'claudian:turn-progress';
/** Workspace event fired with `ClaudianInteractionEvent` when an approval or question starts waiting for the user. */
export const CLAUDIAN_INTERACTION_REQUESTED_EVENT = 'claudian:interaction-requested';
/** Workspace event fired with `ClaudianInteractionEvent` when a request stops waiting, however it ended. */
export const CLAUDIAN_INTERACTION_SETTLED_EVENT = 'claudian:interaction-settled';

export interface ClaudianTurnEndedEvent {
  readonly sessionId: string;
}

export type ClaudianTurnProgressEvent = { readonly sessionId: string } & ResponseProgress;

export interface ClaudianInteractionEvent {
  readonly sessionId: string;
  readonly interactionId: string;
}

export type ClaudianPendingInteraction = PendingInteractionSnapshot;

/**
 * Experimental API for other plugins, reached as `app.plugins.getPlugin('realclaudian').api`.
 * Its shape may change in minor releases while `version` is 1.
 */
export interface ClaudianAPI {
  readonly version: 1;
  /** The session shown in the focused chat view. */
  getActiveSessionId(): string | null;
  /** Sessions most recently active first, with their status; archived sessions are omitted. */
  listSessions(options?: { limit?: number }): Promise<ClientSessionList>;
  /** Shows the session in a chat view, opening one when none exists; focus moves only when asked. */
  openSession(sessionId: string, options?: { focus?: boolean }): Promise<void>;
  /** Delivers text as the user's own prompt; `interrupt` without text only stops the session. */
  send(sessionId: string, options: ClientSendOptions): Promise<SessionToolSendStatus>;
  /** The last finished turn's final reply as Markdown; empty when none has finished. */
  read(sessionId: string): Promise<string>;
  /** Approvals and questions awaiting the user, with every option the prompt offers. */
  getPendingInteractions(sessionId: string): ClaudianPendingInteraction[];
  /** Answers a pending request as its on-screen prompt would; rejects answers the prompt would not accept. */
  answerInteraction(sessionId: string, interactionId: string, answers: AskUserAnswers): Promise<void>;
}

export function createClaudianAPI(
  messaging: SessionMessagingService,
  views: { openSession(sessionId: string, options: { focus: boolean }): Promise<void> },
): ClaudianAPI {
  return Object.freeze({
    version: 1 as const,
    getActiveSessionId: () => messaging.getActiveSessionId(),
    listSessions: (options?: { limit?: number }) => messaging.listSessions(options),
    openSession: async (sessionId: string, options: { focus?: boolean } = {}) => {
      await messaging.requireSession(sessionId);
      await views.openSession(sessionId, { focus: options.focus === true });
    },
    send: (sessionId: string, options: ClientSendOptions) => messaging.sendAsUser(sessionId, options),
    read: (sessionId: string) => messaging.readLastReply(sessionId),
    getPendingInteractions: (sessionId: string) => messaging.getPendingInteractions(sessionId),
    answerInteraction: (sessionId: string, interactionId: string, answers: AskUserAnswers) =>
      messaging.answerInteraction(sessionId, interactionId, answers),
  });
}

/** Maps a session signal to the workspace event other plugins observe. */
export function toClaudianWorkspaceEvent(
  sessionId: string,
  signal: SessionSignal,
): { name: string; payload: ClaudianTurnProgressEvent | ClaudianInteractionEvent } {
  if (signal.type === 'progress') {
    return { name: CLAUDIAN_TURN_PROGRESS_EVENT, payload: { sessionId, ...signal.progress } };
  }
  return {
    name: signal.pending ? CLAUDIAN_INTERACTION_REQUESTED_EVENT : CLAUDIAN_INTERACTION_SETTLED_EVENT,
    payload: { sessionId, interactionId: signal.interactionId },
  };
}
