import { QueryBackedTitleGenerationService } from '../../../core/auxiliary/QueryBackedTitleGenerationService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { isGrokModelSelectionId } from '../models';
import { GrokAuxQueryRunner } from '../runtime/GrokAuxQueryRunner';
import type { GrokAuxiliaryLifecycleOptions } from './GrokAuxiliaryLifecycleCoordinator';

export class GrokTitleGenerationService extends QueryBackedTitleGenerationService {
  constructor(plugin: ProviderHost, lifecycleOptions: GrokAuxiliaryLifecycleOptions = {}) {
    super({
      createRunner: () => new GrokAuxQueryRunner(plugin, lifecycleOptions),
      resolveModel: () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const model = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel.trim()
          : '';
        return model && isGrokModelSelectionId(model) ? model : undefined;
      },
    });
  }
}
