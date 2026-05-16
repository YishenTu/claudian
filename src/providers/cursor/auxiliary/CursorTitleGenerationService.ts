import { QueryBackedTitleGenerationService } from '../../../core/auxiliary/QueryBackedTitleGenerationService';
import type ClaudianPlugin from '../../../main';
import { CursorAuxQueryRunner } from '../runtime/CursorAuxQueryRunner';
import { cursorChatUIConfig } from '../ui/CursorChatUIConfig';

export class CursorTitleGenerationService extends QueryBackedTitleGenerationService {
  constructor(plugin: ClaudianPlugin) {
    super({
      createRunner: () => new CursorAuxQueryRunner(plugin),
      resolveModel: () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const titleModel = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel
          : '';
        return cursorChatUIConfig.ownsModel(titleModel, settings)
          ? titleModel
          : undefined;
      },
    });
  }
}
