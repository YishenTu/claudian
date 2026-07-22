import {
  normalizeProviderCommandDiscoveryItems,
  type ProviderCommandDiscoveryResult,
} from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import type {
  ProviderRuntimeCommandLoader,
  ProviderRuntimeCommandLoaderContext,
} from '../../../core/providers/types';
import type { SlashCommand } from '../../../core/types';
import { OpencodeChatRuntime } from '../runtime/OpencodeChatRuntime';
import { getOpencodeProviderSettings } from '../settings';

const OPENCODE_METADATA_WARMUP_DB = ':memory:';

export class OpencodeRuntimeCommandLoader implements ProviderRuntimeCommandLoader {
  getCacheFingerprint(settings: Record<string, unknown>): string {
    return `opencode:commands:v1:${getOpencodeProviderSettings(settings).enabled ? 'enabled' : 'disabled'}`;
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getOpencodeProviderSettings(settings).enabled;
  }

  async loadCommands(
    context: ProviderRuntimeCommandLoaderContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
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
      return {
        message: 'OpenCode command discovery is unavailable for this tab state.',
        retryable: true,
        status: 'error' as const,
      };
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
      if (shouldWarmPreSessionConversation) {
        // History-backed conversations without a native session must not write
        // metadata warmup sessions into the conversation or default database.
        runtime.syncConversationState({
          providerState: { databasePath: OPENCODE_METADATA_WARMUP_DB },
          sessionId: null,
        });
      } else if (context.conversation) {
        runtime.syncConversationState(context.conversation, context.externalContextPaths);
      } else if (shouldWarmBlankSession) {
        // Blank-tab warmup uses an isolated in-memory session to fetch metadata
        // without binding a persisted OpenCode session to the tab.
        runtime.syncConversationState({
          providerState: { databasePath: OPENCODE_METADATA_WARMUP_DB },
          sessionId: null,
        });
      }

      const commandSnapshot = (runtime as OpencodeChatRuntime).discoverSupportedCommands(5_000);
      void commandSnapshot.catch(() => {});
      const ready = await runtime.ensureReady({
        allowSessionCreation: shouldWarmBlankSession || shouldWarmPreSessionConversation,
      });
      if (!ready) {
        return {
          message: 'Could not load OpenCode commands.',
          retryable: true,
          status: 'error' as const,
        };
      }

      return normalizeProviderCommandDiscoveryItems(await commandSnapshot);
    } catch {
      return {
        message: 'Could not load OpenCode commands.',
        retryable: true,
        status: 'error' as const,
      };
    } finally {
      if (runtime !== context.runtime) {
        runtime.cleanup();
      }
    }
  }
}
