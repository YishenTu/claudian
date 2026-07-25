import {
  normalizeProviderCommandDiscoveryItems,
  type ProviderCommandDiscoveryResult,
} from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import type {
  ProviderRuntimeCommandLoader,
  ProviderRuntimeCommandLoaderContext,
} from '../../../core/providers/types';
import type { SlashCommand } from '../../../core/types';
import { KimiChatRuntime } from '../runtime/KimiChatRuntime';
import { getKimiProviderSettings } from '../settings';

export class KimiRuntimeCommandLoader implements ProviderRuntimeCommandLoader {
  getCacheFingerprint(settings: Record<string, unknown>): string {
    return `kimi:commands:v1:${getKimiProviderSettings(settings).enabled ? 'enabled' : 'disabled'}`;
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getKimiProviderSettings(settings).enabled;
  }

  async loadCommands(
    context: ProviderRuntimeCommandLoaderContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    context.signal?.throwIfAborted();
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
        message: 'Kimi command discovery is unavailable for this tab state.',
        retryable: true,
        status: 'error' as const,
      };
    }

    // Rebinding an already-live tab runtime to a history-backed conversation with
    // no session id must stay cold until the first send. If command discovery
    // creates a real session on that bound runtime, the first turn can skip
    // history bootstrap. Keep this warmup isolated instead.
    const canReuseRuntime = context.runtime?.providerId === 'kimi'
      && !shouldWarmPreSessionConversation;
    const runtime = canReuseRuntime
      ? context.runtime!
      : new KimiChatRuntime(context.plugin);
    let cleanedUp = false;
    const cleanup = (): void => {
      if (runtime === context.runtime || cleanedUp) {
        return;
      }
      cleanedUp = true;
      runtime.cleanup();
    };
    const onAbort = (): void => cleanup();
    context.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (shouldWarmPreSessionConversation) {
        // Kimi advertises commands per ACP session; warmup uses an isolated runtime
        // so no native session is bound to the conversation.
        runtime.syncConversationState(null);
      } else if (context.conversation) {
        runtime.syncConversationState(context.conversation);
      } else if (shouldWarmBlankSession) {
        runtime.syncConversationState(null);
      }

      const commandSnapshot = context.signal
        ? (runtime as KimiChatRuntime).discoverSupportedCommands(5_000, context.signal)
        : (runtime as KimiChatRuntime).discoverSupportedCommands(5_000);
      void commandSnapshot.catch(() => {});
      const ready = await runtime.ensureReady({
        allowSessionCreation: shouldWarmBlankSession || shouldWarmPreSessionConversation,
      });
      context.signal?.throwIfAborted();
      if (!ready) {
        return {
          message: 'Could not load Kimi commands.',
          retryable: true,
          status: 'error' as const,
        };
      }

      return normalizeProviderCommandDiscoveryItems(await commandSnapshot);
    } catch {
      return {
        message: 'Could not load Kimi commands.',
        retryable: true,
        status: 'error' as const,
      };
    } finally {
      context.signal?.removeEventListener('abort', onAbort);
      cleanup();
    }
  }
}
