import { QueryBackedTitleGenerationService } from '../../../core/auxiliary/QueryBackedTitleGenerationService';
import type ClaudianPlugin from '../../../main';
import { toCodexRuntimeModelId } from '../modelSelection';
import { CodexAuxQueryRunner } from '../runtime/CodexAuxQueryRunner';
import { codexChatUIConfig } from '../ui/CodexChatUIConfig';

export class CodexTitleGenerationService extends QueryBackedTitleGenerationService {
  constructor(plugin: ClaudianPlugin) {
    super({
      createRunner: () => new CodexAuxQueryRunner(plugin),
      resolveModel: () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const titleModel = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel
          : '';
        return codexChatUIConfig.ownsModel(titleModel, settings)
          ? toCodexRuntimeModelId(titleModel)
          : undefined;
      },
    });
  }
}
