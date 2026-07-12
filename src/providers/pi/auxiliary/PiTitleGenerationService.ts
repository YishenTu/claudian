import { QueryBackedTitleGenerationService } from '../../../core/auxiliary/QueryBackedTitleGenerationService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { PiAuxQueryRunner } from '../runtime/PiAuxQueryRunner';
import { piChatUIConfig } from '../ui/PiChatUIConfig';

export class PiTitleGenerationService extends QueryBackedTitleGenerationService {
  constructor(plugin: ProviderHost) {
    super({
      createRunner: () => new PiAuxQueryRunner(plugin, { profile: 'passive' }),
      resolveModel: () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const titleModel = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel
          : '';
        return piChatUIConfig.ownsModel(titleModel, settings) ? titleModel : undefined;
      },
    });
  }
}
