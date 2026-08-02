import type { SlashCommand } from '../../types';
import {
  normalizeProviderCommandDiscoveryItems,
  type ProviderCommandDiscoveryResult,
} from './ProviderCommandDiscoveryResult';

export interface RuntimeCommandLoaderOptions<TDiscovery> {
  readonly allowIsolatedMetadataCreation: boolean;
  readonly cleanup?: () => Promise<void> | void;
  readonly discover: (signal?: AbortSignal) => Promise<TDiscovery>;
  readonly errorMessage: string;
  readonly projectItems: (
    discovery: TDiscovery,
  ) => readonly SlashCommand[] | null;
  readonly readyCommandSnapshot?: readonly SlashCommand[];
  readonly requiresSessionMessage: string;
  readonly signal?: AbortSignal;
}

export async function loadRuntimeCommands<TDiscovery>(
  options: RuntimeCommandLoaderOptions<TDiscovery>,
): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
  options.signal?.throwIfAborted();
  if (options.readyCommandSnapshot) {
    return normalizeProviderCommandDiscoveryItems(options.readyCommandSnapshot);
  }
  if (!options.allowIsolatedMetadataCreation) {
    return {
      message: options.requiresSessionMessage,
      status: 'requires-session',
    };
  }

  try {
    const discovery = await options.discover(options.signal);
    options.signal?.throwIfAborted();
    const items = options.projectItems(discovery);
    if (!items) return createErrorResult(options.errorMessage);
    return normalizeProviderCommandDiscoveryItems(items);
  } catch {
    options.signal?.throwIfAborted();
    return createErrorResult(options.errorMessage);
  } finally {
    if (options.cleanup) {
      try {
        await options.cleanup();
      } catch {
        // Cleanup failure must not replace provider discovery semantics.
      }
    }
  }
}

function createErrorResult(
  message: string,
): ProviderCommandDiscoveryResult<SlashCommand> {
  return {
    message,
    retryable: true,
    status: 'error',
  };
}
