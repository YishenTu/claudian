import { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import type { ImageContextManager } from '@/features/chat/composer/ImageContextManager';
import type { ConversationControllerDeps } from '@/features/chat/conversation/ConversationController';
import type { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import type { SessionModel } from '@/features/chat/sessions/SessionModel';
import type { ChatState } from '@/features/chat/state/ChatState';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import { TabSession } from '@/features/chat/tabs/TabSession';
import type { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

/** The fixture state a session model projects into its runtime's admission and idleness. */
export interface SessionModelStubPorts {
  getState?: () => ChatState;
  dismissInteractions?: () => void;
  hasPendingWork?: () => boolean;
}

/** The session model members a runtime reads, for controller fixtures that assemble their own controllers. */
export function createSessionModelStub(session: ChatSessionRuntime, ports: SessionModelStubPorts = {}): SessionModel {
  const stub = {
    get state() { return ports.getState?.() ?? { isRewinding: false }; },
    get hasPendingInteraction() { return ports.getState?.()?.requiresAction ?? false; },
    get hasPendingWork() { return ports.hasPendingWork?.() ?? false; },
    canEvict: true,
    dismissInteractions: () => ports.dismissInteractions?.(),
    publish: () => session.notifyChanged(),
    hydrate: async () => undefined,
    detach: () => undefined,
    dispose: () => undefined,
    drainAuxiliaryWork: async () => undefined,
    inputController: { drainSessionMentionPreparations: async () => undefined },
    conversationController: { awaitCreation: async () => undefined, save: async () => undefined },
  };
  return stub as unknown as SessionModel;
}

/**
 * Real session runtime for controller fixtures. Build the fixture's ChatState from `session.turns`
 * so presentation state derives from the same turn owner, as it does in a session model.
 */
export function createTestSession(options: SessionModelStubPorts & {
  coordinator?: Pick<ChatExecutionCoordinator, 'cancel'>
    & Partial<Pick<ChatExecutionCoordinator, 'cancelBackgroundWork' | 'hasBackgroundWork' | 'publishedBackgroundWork'>>;
} = {}): ChatSessionRuntime {
  const { coordinator, ...ports } = options;
  const execution = {
    cancel: () => coordinator?.cancel(),
    cancelBackgroundWork: () => coordinator?.cancelBackgroundWork?.(),
    get hasBackgroundWork() { return coordinator?.hasBackgroundWork ?? false; },
    get publishedBackgroundWork() { return coordinator?.publishedBackgroundWork ?? false; },
  };
  const session = new ChatSessionRuntime(
    { conversationId: null, providerId: 'pi', draftModel: null },
    execution as unknown as ChatExecutionCoordinator,
    runtime => createSessionModelStub(runtime, ports),
  );
  // Installed eagerly: the runtime reads only an installed model.
  void session.model;
  return session;
}

/** Holds a provider-facing response open until it is cancelled or the returned release settles it. */
export function holdResponse(turns: TurnCoordinator): () => Promise<void> {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const running = turns.run(async signal => {
    turns.beginResponse();
    signal.addEventListener('abort', () => release(), { once: true });
    await released;
  });
  return async () => {
    release();
    await running;
  };
}

/** Real draft and admission owners for controller integration fixtures. */
export function createConversationPorts(deps: Pick<ConversationControllerDeps, 'state'> & {
  getInputEl: () => ComposerInputElement;
  getImageContextManager: () => ImageContextManager | null;
  session?: ChatSessionRuntime;
}): Pick<ConversationControllerDeps, 'drafts' | 'session'> {
  const drafts = new ComposerDraftController({
    getInput: deps.getInputEl, getImages: deps.getImageContextManager, getDestination: () => 'main',
  });
  const session = deps.session ?? createTestSession({ getState: () => deps.state });
  return { drafts, session };
}

/** Builds a real session and its tab projection; the model stub is created only when read. */
export function createTabSession(identity: TabIdentity, coordinator: ChatExecutionCoordinator): TabSession {
  return new TabSession(identity, new ChatSessionRuntime(identity, coordinator, runtime => createSessionModelStub(runtime)));
}
