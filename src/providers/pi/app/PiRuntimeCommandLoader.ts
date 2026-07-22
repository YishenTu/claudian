import {
  normalizeProviderCommandDiscoveryItems,
  type ProviderCommandDiscoveryResult,
} from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import type {
  ProviderRuntimeCommandLoader,
  ProviderRuntimeCommandLoaderContext,
} from '../../../core/providers/types';
import type { SlashCommand } from '../../../core/types';
import { PiChatRuntime } from '../runtime/PiChatRuntime';
import { getPiProviderSettings } from '../settings';
import { getPiState } from '../types';

export class PiRuntimeCommandLoader implements ProviderRuntimeCommandLoader {
  getCacheFingerprint(settings: Record<string, unknown>): string {
    return `pi:commands:v1:${getPiProviderSettings(settings).enabled ? 'enabled' : 'disabled'}`;
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getPiProviderSettings(settings).enabled;
  }

  async loadCommands(
    context: ProviderRuntimeCommandLoaderContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
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
      return {
        message: 'Pi command discovery is unavailable for this tab state.',
        retryable: true,
        status: 'error' as const,
      };
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
        return {
          message: 'Could not load Pi commands.',
          retryable: true,
          status: 'error' as const,
        };
      }

      return normalizeProviderCommandDiscoveryItems(
        await (runtime as PiChatRuntime).discoverSupportedCommands(),
      );
    } catch {
      return {
        message: 'Could not load Pi commands.',
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
