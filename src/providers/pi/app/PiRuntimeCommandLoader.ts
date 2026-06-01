import type {
  ProviderRuntimeCommandLoader,
  ProviderRuntimeCommandLoaderContext,
} from '../../../core/providers/types';
import { PiChatRuntime } from '../runtime/PiChatRuntime';
import { getPiProviderSettings } from '../settings';
import { getPiState } from '../types';

export class PiRuntimeCommandLoader implements ProviderRuntimeCommandLoader {
  isAvailable(settings: Record<string, unknown>): boolean {
    return getPiProviderSettings(settings).enabled;
  }

  async loadCommands(context: ProviderRuntimeCommandLoaderContext) {
    const persistedState = getPiState(context.conversation?.providerState);
    const hasPersistedSession = Boolean(
      context.conversation?.sessionId
      || persistedState.sessionId
      || persistedState.sessionFile,
    );
    const shouldWarmBlankSession = context.allowSessionCreation === true
      && !context.conversation;
    const shouldWarmPreSessionConversation = context.allowSessionCreation === true
      && !!context.conversation
      && !hasPersistedSession
      && context.conversation.messages.length > 0;

    if (!hasPersistedSession && !shouldWarmBlankSession && !shouldWarmPreSessionConversation) {
      return [];
    }

    const canReuseRuntime = context.runtime?.providerId === 'pi'
      && context.runtime.isReady();
    const runtime = canReuseRuntime
      ? context.runtime!
      : new PiChatRuntime(context.plugin);

    try {
      if (canReuseRuntime && context.conversation) {
        runtime.syncConversationState(context.conversation, context.externalContextPaths);
      }

      const ready = await runtime.ensureReady({
        allowSessionCreation: false,
      });
      if (!ready) {
        return [];
      }

      return await runtime.getSupportedCommands();
    } finally {
      if (runtime !== context.runtime) {
        runtime.cleanup();
      }
    }
  }
}
