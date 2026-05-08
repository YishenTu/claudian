import { QueryBackedTitleGenerationService } from '../../../core/auxiliary/QueryBackedTitleGenerationService';
import type ClaudianPlugin from '../../../main';
import { decodeGeminiModelId } from '../models';
import { GeminiAuxQueryRunner } from '../runtime/GeminiAuxQueryRunner';
import { geminiChatUIConfig } from '../ui/GeminiChatUIConfig';

export class GeminiTitleGenerationService extends QueryBackedTitleGenerationService {
  constructor(plugin: ClaudianPlugin) {
    super({
      createRunner: () => new GeminiAuxQueryRunner(plugin, {
        agentProfile: 'passive',
        artifactPurpose: 'title-gen',
      }),
      resolveModel: () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const titleModel = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel
          : '';
        if (!geminiChatUIConfig.ownsModel(titleModel, settings)) {
          return undefined;
        }

        return decodeGeminiModelId(titleModel) ?? undefined;
      },
    });
  }
}
