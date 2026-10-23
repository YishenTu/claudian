import type { SessionToolSendStatus } from '@/core/session-tools/sessionToolSpecs';
import type { ClientSendOptions, SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';

/** Workspace event fired with `ClaudianTurnEndedEvent` when a session finishes its turn and any work it left running. */
export const CLAUDIAN_TURN_ENDED_EVENT = 'claudian:turn-ended';

export interface ClaudianTurnEndedEvent {
  readonly sessionId: string;
}

/**
 * Experimental API for other plugins, reached as `app.plugins.getPlugin('realclaudian').api`.
 * Its shape may change in minor releases while `version` is 1.
 */
export interface ClaudianAPI {
  readonly version: 1;
  /** The session shown in the focused chat view. */
  getActiveSessionId(): string | null;
  /** Delivers text as the user's own prompt; `interrupt` without text only stops the session. */
  send(sessionId: string, options: ClientSendOptions): Promise<SessionToolSendStatus>;
  /** The last finished turn's final reply as Markdown; empty when none has finished. */
  read(sessionId: string): Promise<string>;
}

export function createClaudianAPI(messaging: SessionMessagingService): ClaudianAPI {
  return Object.freeze({
    version: 1 as const,
    getActiveSessionId: () => messaging.getActiveSessionId(),
    send: (sessionId: string, options: ClientSendOptions) => messaging.sendAsUser(sessionId, options),
    read: (sessionId: string) => messaging.readLastReply(sessionId),
  });
}
