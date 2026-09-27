import { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import type { ConversationControllerDeps } from '@/features/chat/controllers/ConversationController';
import { TabSession } from '@/features/chat/tabs/TabSession';
import type { ImageContextManager } from '@/features/chat/ui/ImageContext';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

/** Real draft and admission owners for controller integration fixtures. */
export function createConversationPorts(deps: Pick<ConversationControllerDeps, 'state'> & { getInputEl: () => ComposerInputElement; getImageContextManager: () => ImageContextManager | null }): Pick<ConversationControllerDeps, 'drafts' | 'navigation'> {
  const drafts = new ComposerDraftController({
    getInput: deps.getInputEl, getImages: deps.getImageContextManager, getDestination: () => 'main',
  });
  const navigation = new TabSession({ id: 'test', conversationId: null, providerId: 'pi', draftModel: null, lifecycleState: 'warm' },
    { notifyMayCool: () => undefined } as never, undefined,
    () => deps.state.isStreaming || deps.state.isRewinding || deps.state.isSwitchingConversation || deps.state.isCreatingConversation);
  return { drafts, navigation };
}
