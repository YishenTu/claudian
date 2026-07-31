import { AuxQueryTitleGenerationBackend } from '../../../core/auxiliary/AuxQueryTitleGenerationBackend';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { toCodexRuntimeModelId } from '../modelSelection';
import { CodexAuxQueryRunner } from '../runtime/CodexAuxQueryRunner';
import { codexChatUIConfig } from '../ui/CodexChatUIConfig';

export class CodexTitleGenerationBackend extends AuxQueryTitleGenerationBackend {
  constructor(plugin: ProviderHost) {
    super(
      new CodexAuxQueryRunner(plugin),
      () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const titleModel = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel
          : '';
        return codexChatUIConfig.ownsModel(titleModel, settings)
          ? toCodexRuntimeModelId(titleModel)
          : undefined;
      },
    );
  }
}
