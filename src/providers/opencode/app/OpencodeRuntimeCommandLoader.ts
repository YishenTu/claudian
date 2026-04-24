import type {
  ProviderRuntimeCommandLoader,
  ProviderRuntimeCommandLoaderContext,
} from '../../../core/providers/types';
import { OpencodeChatRuntime } from '../runtime/OpencodeChatRuntime';
import { getOpencodeProviderSettings } from '../settings';

const OPENCODE_METADATA_WARMUP_DB = ':memory:';

export class OpencodeRuntimeCommandLoader implements ProviderRuntimeCommandLoader {
  isAvailable(settings: Record<string, unknown>): boolean {
    return getOpencodeProviderSettings(settings).enabled;
  }

  async loadCommands(context: ProviderRuntimeCommandLoaderContext) {
    const shouldWarmBlankSession = context.allowSessionCreation === true
      && !context.conversation?.sessionId;
    const shouldWarmPreSessionConversation = !!context.conversation
      && !context.conversation.sessionId
      && context.conversation.messages.length > 0;

    if (
      !context.runtime
      && !context.conversation?.sessionId
      && !shouldWarmBlankSession
      && !shouldWarmPreSessionConversation
    ) {
      return [];
    }

    // Rebinding an already-live tab runtime to a history-backed conversation with
    // no session id must stay cold until the first send. If command discovery
    // creates a real session on that bound runtime, the first turn can skip
    // history bootstrap. Keep this warmup isolated instead.
    const canReuseRuntime = context.runtime?.providerId === 'opencode'
      && !shouldWarmPreSessionConversation;
    const runtime = canReuseRuntime
      ? context.runtime!
      : new OpencodeChatRuntime(context.plugin);

    try {
      if (context.conversation) {
        runtime.syncConversationState(context.conversation, context.externalContextPaths);
      } else if (shouldWarmBlankSession) {
        // Blank-tab warmup uses an isolated in-memory session to fetch metadata
        // without binding a persisted OpenCode session to the tab.
        runtime.syncConversationState({
          providerState: { databasePath: OPENCODE_METADATA_WARMUP_DB },
          sessionId: null,
        });
      }

      const ready = await runtime.ensureReady({
        allowSessionCreation: shouldWarmBlankSession || shouldWarmPreSessionConversation,
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
