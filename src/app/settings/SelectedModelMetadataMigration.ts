import type { ProviderHost } from '../../core/providers/ProviderHost';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../../core/providers/ProviderWorkspaceRegistry';

/** Fill incomplete selected-model records through the same native discovery used by settings. */
export async function migrateSelectedModelMetadata(host: ProviderHost, signal: AbortSignal): Promise<void> {
  await Promise.all(ProviderRegistry.getRegisteredProviderIds().map(async providerId => {
    const needsMetadata = () => !signal.aborted
      && ProviderRegistry.isEnabled(providerId, host.settings)
      && ProviderRegistry.getSettingsStorageAdapter(providerId).needsReasoningMetadata?.(host.settings);
    if (!needsMetadata()) return;
    try {
      await ProviderWorkspaceRegistry.ensureInitialized(host, providerId, 'model-metadata-migration');
      // Selection or provider enablement may change while initialization is pending.
      if (!needsMetadata()) return;
      const catalog = ProviderWorkspaceRegistry.getServices(providerId)?.modelCatalog;
      if (!catalog) return;
      const cancel = () => catalog.markStale();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        await catalog.refresh({ force: true });
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    } catch {
      // Keep selected records intact; missing metadata is retried on the next startup.
    }
  }));
}
