import { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import type { ConversationControllerDeps } from '@/features/chat/controllers/ConversationController';
import type { TurnCoordinator } from '@/features/chat/controllers/TurnCoordinator';
import type { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import type { ChatState } from '@/features/chat/state/ChatState';
import { TabSession, type TabSessionOptions } from '@/features/chat/tabs/TabSession';
import type { ImageContextManager } from '@/features/chat/ui/ImageContext';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

/**
 * Real tab session for controller fixtures. Build the fixture's ChatState from `session.turns`
 * so presentation state derives from the same turn owner, as it does in a tab runtime.
 */
export function createTestTabSession(options: {
  getState?: () => ChatState;
  coordinator?: Pick<ChatExecutionCoordinator, 'cancel'> & Partial<Pick<ChatExecutionCoordinator, 'hasBackgroundWork'>>;
} & Pick<TabSessionOptions, 'dismissInteractions' | 'hasDetachedWork'> = {}): TabSession {
  const { getState, coordinator, ...sessionOptions } = options;
  const execution = {
    cancel: () => coordinator?.cancel(),
    get hasBackgroundWork() { return coordinator?.hasBackgroundWork ?? false; },
  };
  return new TabSession(
    { id: 'test', conversationId: null, providerId: 'pi', draftModel: null, lifecycleState: 'open' },
    execution as unknown as ChatExecutionCoordinator,
    {
      ...sessionOptions,
      isConversationBusy: () => {
        const state = getState?.();
        return !!state && (state.isRewinding || state.isSwitchingConversation || state.isResettingToNewChat);
      },
    },
  );
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
  session?: TabSession;
}): Pick<ConversationControllerDeps, 'drafts' | 'session'> {
  const drafts = new ComposerDraftController({
    getInput: deps.getInputEl, getImages: deps.getImageContextManager, getDestination: () => 'main',
  });
  const session = deps.session ?? createTestTabSession({ getState: () => deps.state });
  return { drafts, session };
}
