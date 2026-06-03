import { QueryBackedTitleGenerationService } from '../../../core/auxiliary/QueryBackedTitleGenerationService';
import type ClaudianPlugin from '../../../main';
import { decodeHermesModelId } from '../models';
import { HermesAuxQueryRunner } from '../runtime/HermesAuxQueryRunner';
import { hermesChatUIConfig } from '../ui/HermesChatUIConfig';

export class HermesTitleGenerationService extends QueryBackedTitleGenerationService {
  constructor(plugin: ClaudianPlugin) {
    super({
      createRunner: () => new HermesAuxQueryRunner(plugin),
      resolveModel: () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const titleModel = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel
          : '';
        if (!hermesChatUIConfig.ownsModel(titleModel, settings)) {
          return undefined;
        }

        return decodeHermesModelId(titleModel) ?? undefined;
      },
    });
  }
}
