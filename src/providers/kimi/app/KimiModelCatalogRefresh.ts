import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderModelCatalogRefreshResult } from '../../../core/providers/types';
import {
  getKimiDiscoveryState,
  sameKimiCurrentThinkingByModel,
  sameKimiDiscoveredModels,
  sameKimiThinkingOptionsByModel,
  updateKimiDiscoveryState,
} from '../discoveryState';
import { KimiChatRuntime } from '../runtime/KimiChatRuntime';
import { getKimiProviderSettings, updateKimiProviderSettings } from '../settings';
import { refreshKimiModelMetadata } from './KimiModelMetadata';

// Kimi only advertises its catalog on a live ACP session, so refresh boots an
// isolated runtime, then probes every discovered model's thought_level select on
// the warmup session. Failures keep the previously mirrored/persisted catalog.
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

    const probe = await runtime.probeThinkingOptionsForModels(
      discoveredModels.map((model) => model.rawId),
    );

    // The server-side catalog may have changed config.toml; re-read it so
    // context windows, labels, and image gating stay current.
    refreshKimiModelMetadata(settingsBag);

    // Merge the batch into the mirror: probed models replace their entry, models
    // that advertise no thought_level lose theirs, failed probes stay untouched.
    const discovery = getKimiDiscoveryState(settingsBag);
    const thinkingOptionsByModel = { ...discovery.thinkingOptionsByModel };
    const currentThinkingByModel = { ...discovery.currentThinkingByModel };
    for (const [rawId, options] of Object.entries(probe.thinkingOptionsByModel)) {
      thinkingOptionsByModel[rawId] = options;
      const currentLevel = probe.currentThinkingByModel[rawId];
      if (currentLevel) {
        currentThinkingByModel[rawId] = currentLevel;
      } else {
        delete currentThinkingByModel[rawId];
      }
    }
    for (const rawId of probe.noThinkingRawIds) {
      delete thinkingOptionsByModel[rawId];
      delete currentThinkingByModel[rawId];
    }

    const mirrorChanged = updateKimiDiscoveryState(settingsBag, {
      currentThinkingByModel,
      discoveredModels,
      thinkingOptionsByModel,
    });

    const mirrored = getKimiDiscoveryState(settingsBag);
    const persisted = getKimiProviderSettings(settingsBag);
    const shouldPersistModels = !sameKimiDiscoveredModels(
      persisted.discoveredModels,
      discoveredModels,
    );
    const shouldPersistThinking = !sameKimiThinkingOptionsByModel(
      persisted.thinkingOptionsByModel,
      mirrored.thinkingOptionsByModel,
    ) || !sameKimiCurrentThinkingByModel(
      persisted.currentThinkingByModel,
      mirrored.currentThinkingByModel,
    );
    const persistedChanged = shouldPersistModels || shouldPersistThinking;
    if (persistedChanged) {
      await plugin.mutateSettings((settings) => {
        updateKimiProviderSettings(settings, {
          ...(shouldPersistModels ? { discoveredModels } : {}),
          ...(shouldPersistThinking
            ? {
              currentThinkingByModel: mirrored.currentThinkingByModel,
              thinkingOptionsByModel: mirrored.thinkingOptionsByModel,
            }
            : {}),
        });
      });
    }
    const changed = mirrorChanged || persistedChanged;
    if (changed) {
      plugin.notifyProviderChatOptionsChanged('kimi');
    }
    return {
      changed,
      ...(persistedChanged ? { persistedSettingsChanged: true } : {}),
      ...(probe.failedRawIds.length > 0
        ? { diagnostics: `Could not probe thinking options for: ${probe.failedRawIds.join(', ')}` }
        : {}),
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
