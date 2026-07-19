import { QueryBackedTitleGenerationService } from '../../../core/auxiliary/QueryBackedTitleGenerationService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { decodeKimiModelId } from '../models';
import { KimiAuxQueryRunner } from '../runtime/KimiAuxQueryRunner';
import { kimiChatUIConfig } from '../ui/KimiChatUIConfig';

export class KimiTitleGenerationService extends QueryBackedTitleGenerationService {
  constructor(plugin: ProviderHost) {
    super({
      createRunner: () => new KimiAuxQueryRunner(plugin),
      resolveModel: () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const titleModel = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel
          : '';
        if (!kimiChatUIConfig.ownsModel(titleModel, settings)) {
          return undefined;
        }

        return decodeKimiModelId(titleModel) ?? titleModel;
      },
    });
  }
}
