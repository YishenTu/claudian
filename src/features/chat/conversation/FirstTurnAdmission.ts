import type { ProviderId, TitleGenerationService } from '@/core/providers/types';
import { type ChatMessage, isCanonicalUserMessage } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ConversationController } from '@/features/chat/conversation/ConversationController';
import { ConversationTitleGeneration } from '@/features/chat/conversation/ConversationTitleGeneration';
import type { LinkedContentController, LinkedContentSubmissionToken } from '@/features/chat/linked-content';
import type { ChatState } from '@/features/chat/state/ChatState';
import { cloneChatTurnRequest } from '@/features/chat/state/chatTurnRequest';
import type { ChatTurnRequest } from '@/features/chat/state/types';

export interface FirstTurnAdmissionDeps {
  host: ChatFeatureHost;
  state: ChatState;
  conversationController: Pick<ConversationController, 'createConversation'>;
  getLinkedContentController: () => LinkedContentController;
  getTitleGenerationService: () => TitleGenerationService | null;
}

/** One main turn's admission into its Conversation, from creation through Linked content binding. */
export interface TurnAdmission {
  /**
   * Creates the Conversation this turn starts, freezing the Linked content captured at begin.
   * The target is resolved only when a Conversation must be created.
   */
  ensureConversation(resolveTarget: () => { providerId: ProviderId; model: string | undefined }): Promise<void>;
  /** Titles a Conversation after its first user message is admitted. */
  titleFirstTurn(): Promise<void>;
  /** Returns the captured Linked content draft when this turn never created its Conversation. */
  rollbackIfUncreated(): void;
  /** Binds the Linked content this turn carries to the provider. */
  bind(request: ChatTurnRequest): ChatTurnRequest;
}

/**
 * Owns the first-turn policy of a Conversation: creation with frozen Linked content, its
 * title, and which admitted input carries that Linked content to the provider.
 */
export class FirstTurnAdmission {
  private readonly titles: ConversationTitleGeneration;

  constructor(private readonly deps: FirstTurnAdmissionDeps) {
    this.titles = new ConversationTitleGeneration({
      host: deps.host, getService: () => this.deps.getTitleGenerationService(),
    });
  }

  /** Starts admission before the turn's user message joins the transcript. */
  begin(transcriptBeforeTurn: readonly ChatMessage[], isCompact: boolean): TurnAdmission {
    const { state } = this.deps;
    const linkedContent = this.deps.getLinkedContentController();
    const creation = state.currentConversationId ? null : linkedContent.beginSubmission();

    return {
      ensureConversation: async resolveTarget => {
        if (state.currentConversationId) return;
        if (!creation) {
          throw new Error('Missing Linked content submission for new Conversation');
        }
        const { providerId, model } = resolveTarget();
        await this.deps.conversationController.createConversation(creation, {
          providerId,
          selectedModel: model,
        });
      },
      titleFirstTurn: async () => {
        if (state.messages.length !== 1 || !state.currentConversationId) return;
        const firstUserMessage = state.messages.find(message => message.role === 'user');
        if (!firstUserMessage) return;
        await this.titles.titleFirstTurn(state.currentConversationId, firstUserMessage);
      },
      rollbackIfUncreated: () => {
        if (creation && !state.currentConversationId) {
          linkedContent.rollbackSubmission(creation);
        }
      },
      bind: request => this.#bindLinkedContent(request, { isCompact, creation, transcriptBeforeTurn }),
    };
  }

  /**
   * The first admitted canonical input of a Conversation carries its frozen Linked content: the
   * path captured when this turn created the Conversation, or the path locked into the existing
   * Conversation when an earlier first attempt failed after creation.
   */
  #bindLinkedContent(
    request: ChatTurnRequest,
    admission: {
      isCompact: boolean;
      creation: LinkedContentSubmissionToken | null;
      transcriptBeforeTurn: readonly ChatMessage[];
    },
  ): ChatTurnRequest {
    const isFirstTurn = !admission.isCompact && !admission.transcriptBeforeTurn.some(isCanonicalUserMessage);
    const frozenPath = admission.creation
      ? admission.creation.path
      : this.deps.getLinkedContentController().getSnapshot().path;
    const linkedContentPath = isFirstTurn ? frozenPath ?? undefined : undefined;
    if (request.linkedContentPath === linkedContentPath) return request;

    const admittedRequest = cloneChatTurnRequest(request);
    if (linkedContentPath) {
      admittedRequest.linkedContentPath = linkedContentPath;
    } else {
      delete admittedRequest.linkedContentPath;
    }
    return admittedRequest;
  }
}
