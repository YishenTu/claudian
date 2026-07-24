import {
  normalizeProviderCommandDiscoveryItems,
  type ProviderCommandDiscoveryResult,
} from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import type {
  ProviderRuntimeCommandLoader,
  ProviderRuntimeCommandLoaderContext,
} from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type { SlashCommand } from '../../../core/types';
import { GrokChatRuntime } from '../runtime/GrokChatRuntime';
import { getGrokProviderSettings } from '../settings';

interface GrokRuntimeCommandSource {
  discoverSupportedCommands(timeoutMs?: number, signal?: AbortSignal): Promise<SlashCommand[]>;
  getReadySupportedCommandsSnapshot(): SlashCommand[] | null;
  providerId: 'grok';
}

type GrokRuntimeFactory = (
  plugin: ProviderRuntimeCommandLoaderContext['plugin'],
) => ChatRuntime & GrokRuntimeCommandSource;

function resolveCommandSource(
  runtime: ProviderRuntimeCommandLoaderContext['runtime'],
): (ChatRuntime & GrokRuntimeCommandSource) | null {
  if (
    runtime?.providerId !== 'grok'
    || typeof (runtime as Partial<GrokRuntimeCommandSource>)
      .discoverSupportedCommands !== 'function'
    || typeof (runtime as Partial<GrokRuntimeCommandSource>)
      .getReadySupportedCommandsSnapshot !== 'function'
  ) {
    return null;
  }
  return runtime as ChatRuntime & GrokRuntimeCommandSource;
}

export class GrokRuntimeCommandLoader implements ProviderRuntimeCommandLoader {
  constructor(
    private readonly createRuntime: GrokRuntimeFactory = plugin => new GrokChatRuntime(plugin),
  ) {}

  getCacheFingerprint(settings: Record<string, unknown>): string {
    const providerSettings = getGrokProviderSettings(settings);
    const hasConfiguredCli = providerSettings.cliPath.length > 0
      || Object.values(providerSettings.cliPathsByHost).some(path => path.trim().length > 0);
    return [
      'grok:commands:v2',
      providerSettings.enabled ? 'enabled' : 'disabled',
      hasConfiguredCli ? 'configured-cli' : 'auto-cli',
    ].join(':');
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getGrokProviderSettings(settings).enabled;
  }

  async loadCommands(
    context: ProviderRuntimeCommandLoaderContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    context.signal?.throwIfAborted();
    const activeSource = resolveCommandSource(context.runtime);
    try {
      const commands = activeSource?.getReadySupportedCommandsSnapshot();
      if (commands) {
        return normalizeProviderCommandDiscoveryItems(commands);
      }
    } catch {
      return {
        message: 'Could not read Grok skills and commands from the active conversation.',
        retryable: true,
        status: 'error',
      };
    }

    const runtime = activeSource ?? this.createRuntime(context.plugin);
    let cleanedUp = false;
    const cleanup = (): void => {
      if (activeSource || cleanedUp) {
        return;
      }
      cleanedUp = true;
      runtime.cleanup();
    };
    const onAbort = (): void => cleanup();
    context.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return normalizeProviderCommandDiscoveryItems(
        await runtime.discoverSupportedCommands(5_000, context.signal),
      );
    } catch {
      return {
        message: 'Could not load Grok skills and commands.',
        retryable: true,
        status: 'error',
      };
    } finally {
      context.signal?.removeEventListener('abort', onAbort);
      cleanup();
    }
  }
}
