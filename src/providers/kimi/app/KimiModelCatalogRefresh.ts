import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderModelCatalogRefreshResult } from '../../../core/providers/types';
import { sameKimiDiscoveredModels, updateKimiDiscoveryState } from '../discoveryState';
import { KimiChatRuntime } from '../runtime/KimiChatRuntime';
import { getKimiProviderSettings, updateKimiProviderSettings } from '../settings';

// Kimi only advertises its catalog on a live ACP session, so refresh boots an
// isolated runtime. Failures keep the previously mirrored/persisted catalog.
export async function refreshKimiModelCatalog(
  plugin: ProviderHost,
): Promise<ProviderModelCatalogRefreshResult> {
  const settingsBag = plugin.settings as unknown as Record<string, unknown>;
  if (!getKimiProviderSettings(settingsBag).enabled) {
    return { changed: false };
  }

  const runtime = new KimiChatRuntime(plugin);
  try {
    const loaded = await runtime.ensureReady({ allowSessionCreation: true });
    if (!loaded) {
      return { changed: false, diagnostics: 'Kimi model discovery could not start a session' };
    }
    const discoveredModels = runtime.getDiscoveredModels();
    if (discoveredModels.length === 0) {
      return { changed: false, diagnostics: 'Kimi returned no available models' };
    }

    const mirrorChanged = updateKimiDiscoveryState(settingsBag, { discoveredModels });
    const persistedChanged = !sameKimiDiscoveredModels(
      getKimiProviderSettings(settingsBag).discoveredModels,
      discoveredModels,
    );
    if (persistedChanged) {
      await plugin.mutateSettings((settings) => {
        updateKimiProviderSettings(settings, { discoveredModels });
      });
    }
    const changed = mirrorChanged || persistedChanged;
    if (changed) {
      plugin.notifyProviderChatOptionsChanged('kimi');
    }
    return {
      changed,
      ...(persistedChanged ? { persistedSettingsChanged: true } : {}),
    };
  } catch (error) {
    return {
      changed: false,
      diagnostics: error instanceof Error ? error.message : String(error),
    };
  } finally {
    runtime.cleanup();
  }
}
