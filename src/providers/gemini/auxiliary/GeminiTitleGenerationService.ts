import { QueryBackedTitleGenerationService } from '../../../core/auxiliary/QueryBackedTitleGenerationService';
import type ClaudianPlugin from '../../../main';
import { GeminiAuxQueryRunner } from '../runtime/GeminiAuxQueryRunner';
import { geminiChatUIConfig } from '../ui/GeminiChatUIConfig';

export class GeminiTitleGenerationService extends QueryBackedTitleGenerationService {
  constructor(plugin: ClaudianPlugin) {
    super({
      createRunner: () => new GeminiAuxQueryRunner(plugin),
      resolveModel: () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const titleModel = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel
          : '';
        return geminiChatUIConfig.ownsModel(titleModel) ? titleModel : undefined;
      },
    });
  }
}
