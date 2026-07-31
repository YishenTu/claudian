import { AuxQueryTitleGenerationBackend } from '../../../core/auxiliary/AuxQueryTitleGenerationBackend';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { isGrokModelSelectionId } from '../models';
import { GrokAuxQueryRunner } from '../runtime/GrokAuxQueryRunner';
import type { GrokAuxiliaryLifecycleOptions } from './GrokAuxiliaryLifecycleCoordinator';

export class GrokTitleGenerationBackend extends AuxQueryTitleGenerationBackend {
  constructor(plugin: ProviderHost, lifecycleOptions: GrokAuxiliaryLifecycleOptions = {}) {
    super(
      new GrokAuxQueryRunner(plugin, lifecycleOptions),
      () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const model = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel.trim()
          : '';
        return model && isGrokModelSelectionId(model) ? model : undefined;
      },
    );
  }
}
